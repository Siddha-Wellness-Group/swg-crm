-- swg-crm — MICHA full CRM access gateway (owner decision 23.11.2026 ~09:30: MICHA may read everything in the CRM
-- and edit records; every edit is approved by the user in MICHA first, logged with before/after, and undoable).
--
-- public.micha_crm_gateway(p_op, p_actor_email, p_args) — called ONLY by MICHA's server:
--   * authorised by the existing gateway key (micha_gateway.key: SHA-256 digest, expiry, revoke switch);
--   * acts AS the named CRM staff member: the email must belong to an active public.crm_staff user, and that user's
--     role permissions (public.crm_role_permissions — the same table the CRM app enforces) decide every edit;
--   * reads return full records (names, emails, phones, messages, notes) — owner decision; deletes are NOT offered;
--   * edits touch only whitelisted columns, record the previous values in micha_gateway.write_log and can be undone
--     (only when the row still holds the values MICHA wrote — no silent overwrite of someone else's later change);
--   * rate limits: 600 reads / 60 writes per hour overall; every call is in micha_gateway.call_log.
-- Rollback: 20261123100001_rollback_micha_crm_gateway_rw.sql (kept beside this file, not auto-applied).
BEGIN;

CREATE TABLE IF NOT EXISTS micha_gateway.write_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_email text NOT NULL,
  actor_role  text NOT NULL,
  op          text NOT NULL CHECK (op IN ('update','create','undo')),
  entity      text NOT NULL,
  row_id      text NOT NULL,
  before      jsonb,
  after       jsonb,
  undone_at   timestamptz,
  undo_of     uuid REFERENCES micha_gateway.write_log(id)
);
ALTER TABLE micha_gateway.call_log ADD COLUMN IF NOT EXISTS op text;
REVOKE ALL ON ALL TABLES IN SCHEMA micha_gateway FROM PUBLIC, anon, authenticated;

-- editable columns per entity (anything else is refused)
CREATE OR REPLACE FUNCTION micha_gateway.editable(p_entity text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_entity
    WHEN 'tickets'   THEN ARRAY['status','assigned_to','notes','subject']
    WHEN 'leads'     THEN ARRAY['status','notes','owner','department','name','company','email','phone']
    WHEN 'contacts'  THEN ARRAY['notes','owner','department','name','company','email','phone','kind','type']
    WHEN 'customers' THEN ARRAY['notes','owner','department','name','company','email','phone','country','city']
    WHEN 'deals'     THEN ARRAY['stage','notes','owner','title','value']
    WHEN 'orders'    THEN ARRAY['status','notes','tracking_number','carrier_name','tracking_url']
    WHEN 'tasks'     THEN ARRAY['status','notes','title','due_date','owner']
    WHEN 'education_requests' THEN ARRAY['stage','notes','owner']
    ELSE ARRAY[]::text[] END
$$;

CREATE OR REPLACE FUNCTION public.micha_crm_gateway(p_op text, p_actor_email text, p_args jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET statement_timeout = '6s' AS $fn$
DECLARE
  supplied text := current_setting('request.headers', true)::jsonb->>'x-micha-gateway-key';
  v_role text; v_entity text; v_id text; v_row jsonb; v_patch jsonb; v_before jsonb := '{}'::jsonb; v_after jsonb;
  v_key text; v_log micha_gateway.write_log; v_hours int; v_limit int; v_since bigint; v_set text := ''; v_q text;
  v_tables constant text[] := ARRAY['tickets','leads','contacts','customers','deals','orders','tasks','education_requests','distributors','suppliers','products','invoices','payments'];
  v_perm_object text;
  writes constant text[] := ARRAY['update','create_task','undo'];
BEGIN
  IF supplied IS NULL OR supplied !~ '^[A-Za-z0-9_-]{43,64}$' THEN RETURN jsonb_build_object('error','unauthorized'); END IF;
  IF NOT EXISTS (SELECT 1 FROM micha_gateway.key k WHERE k.digest = sha256(convert_to(supplied, 'UTF8'))
                 AND k.revoked_at IS NULL AND k.released_until > clock_timestamp()) THEN
    INSERT INTO micha_gateway.call_log(ok, op) VALUES (false, left(coalesce(p_op,''), 30));
    RETURN jsonb_build_object('error','unauthorized');
  END IF;
  IF p_op = ANY(writes) THEN
    IF (SELECT count(*) FROM micha_gateway.call_log WHERE ok AND op = ANY(writes) AND at > clock_timestamp() - interval '1 hour') >= 60 THEN
      RETURN jsonb_build_object('error','rate_limited'); END IF;
  ELSIF (SELECT count(*) FROM micha_gateway.call_log WHERE at > clock_timestamp() - interval '1 hour') >= 600 THEN
    RETURN jsonb_build_object('error','rate_limited');
  END IF;

  -- the CRM identity MICHA acts as
  SELECT s.role INTO v_role FROM public.crm_staff s JOIN auth.users u ON u.id = s.user_id
   WHERE lower(u.email) = lower(btrim(coalesce(p_actor_email,''))) AND s.active LIMIT 1;
  IF v_role IS NULL THEN
    INSERT INTO micha_gateway.call_log(ok, op) VALUES (false, left(p_op, 30));
    RETURN jsonb_build_object('error','not_crm_staff');
  END IF;
  INSERT INTO micha_gateway.call_log(ok, op) VALUES (true, left(p_op, 30));

  IF p_op = 'whoami' THEN
    RETURN jsonb_build_object('role', v_role, 'permissions', coalesce((SELECT jsonb_object_agg(object, jsonb_build_object('create', can_create, 'edit', can_edit))
      FROM public.crm_role_permissions WHERE role = v_role), '{}'::jsonb));

  ELSIF p_op = 'recent_enquiries' THEN
    v_hours := least(greatest(coalesce((p_args->>'hours')::int, 24), 1), 24*14);
    v_limit := least(greatest(coalesce((p_args->>'limit')::int, 30), 1), 50);
    v_since := ((extract(epoch FROM clock_timestamp()) - v_hours*3600) * 1000)::bigint;
    RETURN jsonb_build_object('window_hours', v_hours, 'role', v_role,
      'as_of', to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'items', coalesce((SELECT jsonb_agg(s.x ORDER BY s.x->>'received_at' DESC) FROM (
        SELECT u.x FROM (
          SELECT jsonb_build_object('type','ticket','id',t.id,'reference',t.ticket_number,'site',t.source,'status',t.status,
                   'received_at', to_char(to_timestamp(t.created_at/1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                   'name',t.name,'email',t.email,'phone',t.phone,'subject',t.subject,'message',left(t.message,2000),
                   'assigned_to',t.assigned_to,'notes',left(t.notes,1000)) AS x
            FROM public.tickets t WHERE t.created_at >= v_since
          UNION ALL
          SELECT jsonb_build_object('type','education_request','id',e.id,'reference',e.id,'site',coalesce(e.source,'Siddha Education'),
                   'status',coalesce(e.stage,'New'),'received_at', to_char(to_timestamp(e.created_at/1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                   'name',btrim(coalesce(e.first_name,'') || ' ' || coalesce(e.last_name,'')),'phone',e.phone,'organization',coalesce(e.org,e.org_other),
                   'participants',e.participants,'format',e.format,'timing',e.timing,'location',coalesce(e.location,e.location_other),
                   'recommended_service',e.recommended_service_name,'notes',left(e.notes,1000)) AS x
            FROM public.education_requests e WHERE e.created_at >= v_since
        ) u ORDER BY u.x->>'received_at' DESC LIMIT v_limit) s), '[]'::jsonb));

  ELSIF p_op = 'get_record' THEN
    v_entity := p_args->>'entity';
    IF NOT (v_entity = ANY(v_tables)) THEN RETURN jsonb_build_object('error','unknown_entity'); END IF;
    IF v_entity = 'tickets' AND p_args ? 'reference' THEN
      SELECT to_jsonb(t) INTO v_row FROM public.tickets t WHERE t.ticket_number = upper(p_args->>'reference') LIMIT 1;
    ELSE
      EXECUTE format('SELECT to_jsonb(r) FROM public.%I r WHERE r.id = $1 LIMIT 1', v_entity) INTO v_row USING p_args->>'id';
    END IF;
    IF v_row IS NULL THEN RETURN jsonb_build_object('error','not_found'); END IF;
    RETURN jsonb_build_object('entity', v_entity, 'record', v_row - 'ip_hash', 'role', v_role,
      'can_edit', coalesce((SELECT can_edit FROM public.crm_role_permissions WHERE role = v_role AND object = v_entity), v_role = 'admin'),
      'editable_fields', to_jsonb(micha_gateway.editable(v_entity)));

  ELSIF p_op = 'search' THEN
    v_entity := p_args->>'entity'; v_q := left(btrim(coalesce(p_args->>'q','')), 80);
    v_limit := least(greatest(coalesce((p_args->>'limit')::int, 10), 1), 25);
    IF NOT (v_entity = ANY(v_tables)) OR length(v_q) < 2 THEN RETURN jsonb_build_object('error','bad_search'); END IF;
    EXECUTE format($q$SELECT coalesce(jsonb_agg(to_jsonb(r) - 'ip_hash'), '[]'::jsonb) FROM (SELECT * FROM public.%I r
                      WHERE to_jsonb(r)::text ILIKE '%%' || $1 || '%%' ORDER BY r.created_at DESC LIMIT $2) r$q$, v_entity)
      INTO v_row USING replace(replace(v_q, '%', ''), '_', ''), v_limit;
    RETURN jsonb_build_object('entity', v_entity, 'q', v_q, 'items', v_row, 'role', v_role);

  ELSIF p_op = 'update' THEN
    v_entity := p_args->>'entity'; v_patch := p_args->'patch';
    v_perm_object := CASE WHEN v_entity = 'education_requests' THEN 'leads' ELSE v_entity END;
    IF micha_gateway.editable(v_entity) = ARRAY[]::text[] OR jsonb_typeof(v_patch) IS DISTINCT FROM 'object' OR v_patch = '{}'::jsonb THEN
      RETURN jsonb_build_object('error','not_editable'); END IF;
    IF NOT coalesce((SELECT can_edit FROM public.crm_role_permissions WHERE role = v_role AND object = v_perm_object), false) THEN
      RETURN jsonb_build_object('error','forbidden_for_role', 'role', v_role); END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_patch) k WHERE NOT (k = ANY(micha_gateway.editable(v_entity)))) THEN
      RETURN jsonb_build_object('error','field_not_editable'); END IF;
    -- values must be ones the CRM app itself offers
    IF (v_entity = 'tickets' AND v_patch ? 'status' AND NOT (v_patch->>'status' = ANY(ARRAY['new','open','resolved','closed'])))
       OR (v_entity = 'leads' AND v_patch ? 'status' AND NOT (v_patch->>'status' = ANY(ARRAY['New','Qualified','Working','Converted','Disqualified'])))
       OR (v_entity = 'tasks' AND v_patch ? 'status' AND NOT (v_patch->>'status' = ANY(ARRAY['Open','Done'])))
       OR (v_entity = 'deals' AND v_patch ? 'stage' AND NOT (v_patch->>'stage' = ANY(ARRAY['Lead','Contacted','Negotiation','Won','Lost']))) THEN
      RETURN jsonb_build_object('error','invalid_value'); END IF;
    IF v_entity = 'tickets' AND p_args ? 'reference' THEN
      SELECT t.id INTO v_id FROM public.tickets t WHERE t.ticket_number = upper(p_args->>'reference');
    ELSE v_id := p_args->>'id'; END IF;
    EXECUTE format('SELECT to_jsonb(r) FROM public.%I r WHERE r.id = $1 FOR UPDATE', v_entity) INTO v_row USING v_id;
    IF v_row IS NULL THEN RETURN jsonb_build_object('error','not_found'); END IF;
    FOR v_key IN SELECT jsonb_object_keys(v_patch) LOOP
      v_before := v_before || jsonb_build_object(v_key, v_row->v_key);
      v_set := v_set || format('%I = (jsonb_populate_record(NULL::public.%I, $2)).%I, ', v_key, v_entity, v_key);
    END LOOP;
    EXECUTE format('UPDATE public.%I SET %s WHERE id = $1', v_entity, left(v_set, length(v_set) - 2)) USING v_id, v_patch;
    EXECUTE format('SELECT to_jsonb(r) FROM public.%I r WHERE r.id = $1', v_entity) INTO v_row USING v_id;
    SELECT jsonb_object_agg(k, v_row->k) INTO v_after FROM jsonb_object_keys(v_patch) k;
    INSERT INTO micha_gateway.write_log(actor_email, actor_role, op, entity, row_id, before, after)
      VALUES (lower(p_actor_email), v_role, 'update', v_entity, v_id, v_before, v_after) RETURNING * INTO v_log;
    RETURN jsonb_build_object('write_id', v_log.id, 'entity', v_entity, 'id', v_id, 'before', v_before, 'after', v_after);

  ELSIF p_op = 'create_task' THEN
    IF NOT coalesce((SELECT can_create FROM public.crm_role_permissions WHERE role = v_role AND object = 'tasks'), false) THEN
      RETURN jsonb_build_object('error','forbidden_for_role', 'role', v_role); END IF;
    IF length(btrim(coalesce(p_args->>'title',''))) < 2 THEN RETURN jsonb_build_object('error','title_required'); END IF;
    v_id := 'tsk_' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO public.tasks(id, created_at, owner, title, due_date, status, link_type, link_id, notes)
    VALUES (v_id, (extract(epoch FROM clock_timestamp())*1000)::bigint, left(coalesce(p_args->>'owner', lower(p_actor_email)), 80),
            left(p_args->>'title', 200), nullif(p_args->>'due_date','')::date, 'Open', left(p_args->>'link_type', 30), left(p_args->>'link_id', 80),
            left(p_args->>'notes', 2000));
    SELECT to_jsonb(t) INTO v_after FROM public.tasks t WHERE t.id = v_id;
    INSERT INTO micha_gateway.write_log(actor_email, actor_role, op, entity, row_id, before, after)
      VALUES (lower(p_actor_email), v_role, 'create', 'tasks', v_id, NULL, v_after) RETURNING * INTO v_log;
    RETURN jsonb_build_object('write_id', v_log.id, 'entity', 'tasks', 'id', v_id, 'after', v_after);

  ELSIF p_op = 'undo' THEN
    SELECT * INTO v_log FROM micha_gateway.write_log WHERE id = (p_args->>'write_id')::uuid FOR UPDATE;
    IF NOT FOUND OR v_log.undone_at IS NOT NULL OR v_log.op = 'undo' THEN RETURN jsonb_build_object('error','not_undoable'); END IF;
    IF v_log.actor_email <> lower(p_actor_email) AND v_role <> 'admin' THEN RETURN jsonb_build_object('error','forbidden_for_role'); END IF;
    IF v_log.op = 'create' THEN
      DELETE FROM public.tasks WHERE id = v_log.row_id AND to_jsonb(tasks) @> (v_log.after - 'created_at');
      IF NOT FOUND THEN RETURN jsonb_build_object('error','changed_since'); END IF;
    ELSE
      EXECUTE format('SELECT to_jsonb(r) FROM public.%I r WHERE r.id = $1 FOR UPDATE', v_log.entity) INTO v_row USING v_log.row_id;
      IF v_row IS NULL OR NOT (v_row @> v_log.after) THEN RETURN jsonb_build_object('error','changed_since'); END IF;
      FOR v_key IN SELECT jsonb_object_keys(v_log.before) LOOP
        v_set := v_set || format('%I = (jsonb_populate_record(NULL::public.%I, $2)).%I, ', v_key, v_log.entity, v_key);
      END LOOP;
      EXECUTE format('UPDATE public.%I SET %s WHERE id = $1', v_log.entity, left(v_set, length(v_set) - 2)) USING v_log.row_id, v_log.before;
    END IF;
    UPDATE micha_gateway.write_log SET undone_at = clock_timestamp() WHERE id = v_log.id;
    INSERT INTO micha_gateway.write_log(actor_email, actor_role, op, entity, row_id, before, after, undo_of)
      VALUES (lower(p_actor_email), v_role, 'undo', v_log.entity, v_log.row_id, v_log.after, v_log.before, v_log.id);
    RETURN jsonb_build_object('undone', v_log.id, 'entity', v_log.entity, 'id', v_log.row_id, 'restored', v_log.before);
  END IF;
  RETURN jsonb_build_object('error','unknown_op');
END $fn$;
REVOKE ALL ON FUNCTION public.micha_crm_gateway(text, text, jsonb) FROM PUBLIC, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.micha_crm_gateway(text, text, jsonb) TO anon;

COMMIT;
