-- Item 4 of the CRM <-> email integration: the "status -> Shipped" trigger
-- (checkOrderStatusChange in swg_crm.html) needs somewhere to read a
-- tracking number, carrier and tracking URL from before it can send a real
-- shippingUpdate email. None of that currently exists on `orders` -- the
-- storefront's own Order entity only carries a bare tracking_number, no
-- carrier or URL -- so this adds all three directly to the CRM's orders
-- table, editable from the order's edit form regardless of where the order
-- came from.

alter table orders add column if not exists tracking_number text;
alter table orders add column if not exists carrier_name text;
alter table orders add column if not exists tracking_url text;
