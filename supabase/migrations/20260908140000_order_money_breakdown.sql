-- The storefront sends subtotal, shipping_cost, discount_amount and
-- tax_amount on every order (they are all on the Base44 Order entity), but
-- 20260831140000_storefront_sync_fields.sql never created columns for them,
-- so they were dropped on arrival.
--
-- That surfaced in the customer's order confirmation: a real order showed
-- one item at 148 and a total of 183, with the 35 shipping unexplained.
-- From the customer's side that reads as a billing error.
--
-- Storing the breakdown so the email can show what the total is made of.

alter table orders add column if not exists subtotal numeric;
alter table orders add column if not exists shipping_cost numeric;
alter table orders add column if not exists discount_amount numeric;
alter table orders add column if not exists discount_code text;
alter table orders add column if not exists tax_amount numeric;
