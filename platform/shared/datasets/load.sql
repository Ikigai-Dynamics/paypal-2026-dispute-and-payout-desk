-- Reloads schema demo from the dataset JSON passed as the psql variable :content.
-- Dates were already shifted so the dataset's anchor is now (see datasets-load).
begin;
drop schema if exists demo cascade;
create schema demo;
create temp table src on commit drop as select :'content'::jsonb as c;

create table demo.merchant as
  select (select c from src)->'merchant'->>'merchant_id' as merchant_id,
         (select c from src)->'merchant'->>'name' as name,
         (select c from src)->'merchant' as doc;
alter table demo.merchant add primary key (merchant_id);

create table demo.products as
  select p->>'sku' as sku, p->>'name' as name, p->>'category' as category,
         round((p->'price'->>'value')::numeric * 100)::int as price_cents,
         p->'price'->>'currency_code' as currency, p as doc
  from jsonb_array_elements((select c from src)->'products') p;
alter table demo.products add primary key (sku);

create table demo.buyers as
  select b->>'buyer_id' as buyer_id, b->>'account_id' as account_id,
         (b->>'given_name') || ' ' || (b->>'surname') as name, b->>'email_address' as email,
         b->>'country_code' as country_code, b->>'shopper_kind' as shopper_kind,
         b->>'device' as device, b as doc
  from jsonb_array_elements((select c from src)->'buyers') b;
alter table demo.buyers add primary key (buyer_id);

create table demo.transactions as
  select t->'transaction_info'->>'transaction_id' as transaction_id,
         t->'transaction_info'->>'transaction_event_code' as event_code,
         (t->'transaction_info'->>'transaction_initiation_date')::timestamptz as initiated_at,
         round((t->'transaction_info'->'transaction_amount'->>'value')::numeric * 100)::int as amount_cents,
         round((t->'transaction_info'->'fee_amount'->>'value')::numeric * 100)::int as fee_cents,
         t->'transaction_info'->'transaction_amount'->>'currency_code' as currency,
         t->'transaction_info'->>'transaction_subject' as subject,
         t->'transaction_info'->>'invoice_id' as invoice_id,
         (select b.buyer_id from demo.buyers b where b.account_id = t->'payer_info'->>'account_id') as buyer_id,
         t->'cart_info'->'item_details' as items, t as doc
  from jsonb_array_elements((select c from src)->'transactions') t;
alter table demo.transactions add primary key (transaction_id);

create table demo.disputes as
  select d->>'dispute_id' as dispute_id,
         d->'disputed_transactions'->0->>'seller_transaction_id' as transaction_id,
         (select t.buyer_id from demo.transactions t where t.transaction_id = d->'disputed_transactions'->0->>'seller_transaction_id') as buyer_id,
         d->>'reason' as reason, d->>'dispute_life_cycle_stage' as stage, d->>'status' as status,
         d->>'dispute_state' as state,
         round((d->'dispute_amount'->>'value')::numeric * 100)::int as amount_cents,
         d->'dispute_amount'->>'currency_code' as currency,
         (d->>'create_time')::timestamptz as created_at, (d->>'update_time')::timestamptz as updated_at,
         (d->>'seller_response_due_date')::timestamptz as response_due_at,
         d->>'outcome' as outcome,
         d->'disputed_transactions'->0->'items' as items,
         d->'messages' as messages, d->'evidences' as evidences, d as doc
  from jsonb_array_elements((select c from src)->'disputes') d;
alter table demo.disputes add primary key (dispute_id);
create index on demo.disputes (response_due_at);
create index on demo.transactions (buyer_id, initiated_at);
commit;
