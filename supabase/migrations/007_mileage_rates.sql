-- 007: Per-mile pricing bands, so a rate request for a lane with no saved tariff still gets a
-- price: [{equipment_type, container_size?, min_miles, max_miles?, per_mile, minimum,
-- fuel_surcharge, round_trip}]. Empty means no mileage pricing (quotes fall back to tariffs only).
alter table organizations add column if not exists mileage_rates jsonb not null default '[]'::jsonb;
