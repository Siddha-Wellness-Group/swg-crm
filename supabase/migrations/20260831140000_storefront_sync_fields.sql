-- Adds the fields needed to receive real storefront orders (starting with
-- the Siddha Yoga / Base44 store) without losing data the storefront
-- actually sends: a real transaction currency, full shipping address,
-- payment status, and multiple line items per order.
--
-- external_order_number + source together give each storefront order a
-- stable identity, so a retried webhook delivery updates the same row
-- instead of creating a duplicate.

alter table customers add column if not exists source text;
alter table orders add column if not exists source text;
alter table orders add column if not exists external_order_number text;
alter table orders add column if not exists payment_status text;
alter table orders add column if not exists payment_provider text;
alter table orders add column if not exists payment_reference text;
alter table orders add column if not exists shipping_address jsonb;
alter table orders add column if not exists items jsonb not null default '[]';
alter table orders add column if not exists currency text;

create unique index if not exists orders_source_external_number_key
  on orders (source, external_order_number)
  where external_order_number is not null;
