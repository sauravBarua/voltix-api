-- Every stock update writes an outbox event in the SAME transaction (statement-level: one row per UPDATE).
-- The worker publishes it and the cache-invalidation consumer drops the cached availability of those variants.
CREATE FUNCTION enqueue_inventory_changed() RETURNS trigger AS $$
BEGIN
  INSERT INTO outbox_events (id, aggregate_type, aggregate_id, type, payload)
  SELECT gen_random_uuid(), 'inventory', 'inventory', 'inventory.changed',
         jsonb_build_object('variantIds', jsonb_agg(DISTINCT variant_id))
  FROM new_rows
  HAVING count(*) > 0;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "inventory_items_changed"
  AFTER UPDATE ON "inventory_items"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION enqueue_inventory_changed();
