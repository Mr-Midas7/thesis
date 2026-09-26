-- Configure the Engine Overhaul service for catalog models verified by
-- 500cc_and_up_models.pdf. The source list excludes named "500" models that
-- are actually below the 500cc threshold.
--
-- The migration only applies to active, non-archived catalog rows whose brand
-- and model match the source list after harmless spacing/punctuation
-- normalization. Unmatched and ambiguous catalog entries are intentionally
-- left unchanged.

DO $$
DECLARE
  v_engine_overhaul_id uuid;
BEGIN
  SELECT id
  INTO v_engine_overhaul_id
  FROM public.services
  WHERE name = 'Engine Overhaul'
    AND is_archived = false
  ORDER BY created_at
  LIMIT 1;

  IF v_engine_overhaul_id IS NULL THEN
    RAISE EXCEPTION 'Engine Overhaul service is required before creating model overrides';
  END IF;

  WITH source_model_groups (brand, models) AS (
    VALUES
      ('Honda', ARRAY['CBR600RR', 'CBR650R', 'CBR1000RR', 'CBR1000RR-R', 'Rebel1100', 'CB650R', 'CB1000R', 'NC750X', 'X-ADV', 'Africa Twin', 'Africa Twin 1100', 'Gold Wing']::text[]),
      ('Yamaha', ARRAY['MT-07', 'MT-09', 'MT-10', 'Tenere 700', 'XSR700', 'XSR900', 'VMAX', 'TMAX', 'Bolt', 'R6', 'R1']::text[]),
      ('Suzuki', ARRAY['GSX-R600', 'GSX-R750', 'GSX-R1000', 'V-Strom650', 'V-Strom800', 'V-Strom1050', 'SV650', 'SV1000', 'DR650', 'Boulevard M109R', 'Boulevard C50', 'Boulevard C90', 'Hayabusa', 'Katana', 'GSX-S1000']::text[]),
      ('Kawasaki', ARRAY['KLR650', 'Ninja650', 'Ninja ZX-6R', 'Ninja ZX-10R', 'Ninja H2', 'Z650', 'Z750', 'Z800', 'Z900', 'Z1000', 'Versys650', 'Versys1000', 'Vulcan S', 'Vulcan900', 'Vulcan1700']::text[]),
      ('Kymco', ARRAY['AK550']::text[]),
      ('CFMOTO', ARRAY['650NK', '675NK', '800NK', '500SR', '675SR-R', '750SR-S', '650MT', '700MT', '800MT', '800MT Sport', '800MT Explore', '800MT-X', '1000MT-X', '700CL-X', '700CL-X Heritage', '700CL-X Sport', '700CL-X ADV', '650GT', '650TR', '1250TR']::text[]),
      ('Benelli', ARRAY['TNT600i', 'TNT600GT', 'BN600', 'Leoncino500', 'Leoncino500 Trail', 'Leoncino800', 'TRK502', 'TRK502X', 'TRK702', 'TRK702X', '502C', '752S', '752C', '1200GT', '1200GT SE']::text[]),
      ('KTM', ARRAY['Duke690', 'Duke790', 'Duke890', 'Duke990', 'Duke1290', 'Adventure790', 'Adventure890', 'Adventure1050', 'Adventure1090', 'Adventure1190', 'Adventure1290', '500 EXC', '690 Enduro', '690 SMC', '500 EXC-F']::text[]),
      ('Bristol', ARRAY['Bobber650', 'Cafe500', 'Scrambler500', 'Adventure500', 'Bullet500', 'Maxie500', 'Veloce500', 'Veloce650']::text[]),
      ('Royal Enfield', ARRAY['Bullet500', 'Classic500', 'Classic500 FI', 'Classic650', 'Thunderbird500', 'Thunderbird X500', 'Interceptor650', 'Continental GT650', 'ContinentalGT', 'Super Meteor650', 'Shotgun650', 'Bear650', 'Electra500']::text[]),
      ('SYM', ARRAY['Maxsym600i']::text[]),
      ('Zontes', ARRAY['703F', '703R', '703RR', '703T']::text[]),
      ('Piaggio', ARRAY['MP3 500', 'MP3 530']::text[]),
      ('BMW Motorrad', ARRAY['F650GS', 'F700GS', 'F750GS', 'F800GS', 'F800R', 'F800GT', 'F850GS', 'F850GSA', 'F900R', 'F900XR', 'R850R', 'R1100R', 'R1150R', 'R1200GS', 'R1200GSA', 'R1250GS', 'R1250GSA', 'R1250R', 'R1250RS', 'R1300GS', 'R1300GSA', 'R nineT', 'R12', 'S1000RR', 'S1000R', 'S1000XR', 'S1000', 'K1200R', 'K1300R', 'K1600GT', 'K1600GTL', 'K1600B', 'K1600 Grand America']::text[]),
      ('Ducati', ARRAY['Monster600', 'Monster620', 'Monster695', 'Monster696', 'Monster796', 'Monster821', 'Monster937', 'Monster1100', 'Monster1200', 'Monster1200R', 'MonsterSP', 'Scrambler800', 'Scrambler Icon', 'Scrambler1100', 'Scrambler1100 Sport', 'Panigale899', 'Panigale959', 'Panigale V2', 'Panigale V4', 'Panigale V4R', '848', '1098', '1198', '1299', 'Streetfighter848', 'Streetfighter1098', 'Streetfighter V2', 'Streetfighter V4', 'Multistrada950', 'Multistrada1200', 'Multistrada1260', 'Multistrada V2', 'Multistrada V4', 'Diavel', 'Diavel1260', 'Diavel V4', 'XDiavel', 'Hypermotard796', 'Hypermotard821', 'Hypermotard939', 'Hypermotard950', 'DesertX', 'SuperSport', 'SuperSport950']::text[]),
      ('Harley-Davidson', ARRAY['Sportster883', 'Sportster1200', 'Iron883', 'Iron1200', 'Forty-Eight', 'Forty-Eight Special', 'Nightster', 'Nightster Special', 'Street500', 'Street750', 'Street Bob', 'Street Bob114', 'Low Rider', 'Low Rider S', 'Low Rider ST', 'Fat Bob', 'Fat Bob114', 'Fat Boy', 'Fat Boy114', 'Heritage Classic', 'Heritage Classic114', 'Breakout', 'Breakout114', 'Softail Standard', 'Deluxe', 'Slim', 'Road King', 'Road King Special', 'Road Glide', 'Road Glide Special', 'Road Glide Limited', 'Street Glide', 'Street Glide Special', 'Electra Glide Ultra Limited', 'Pan America1250', 'Pan America1250 Special', 'Sportster S', 'LiveWire']::text[]),
      ('Triumph', ARRAY['Bonneville', 'Bonneville T100', 'Bonneville T120', 'Bonneville Bobber', 'Bobber1200', 'Speedmaster', 'Scrambler900', 'Scrambler1200', 'Street Scrambler', 'Street Twin', 'Speed Twin900', 'Speed Twin1200', 'Street Triple675', 'Street Triple765', 'Street Triple R', 'Street Triple RS', 'Speed Triple1050', 'Speed Triple1200', 'Daytona675', 'Daytona765', 'Daytona955i', 'Tiger800', 'Tiger850', 'Tiger900', 'Tiger1200', 'Tiger Explorer1200', 'Tiger Sport660', 'Tiger Sport850', 'Tiger Sport1050', 'Rocket III', 'Rocket3', 'Trident660', 'Thruxton900', 'Thruxton1200', 'SprintST', 'SprintGT', 'Daytona1200']::text[]),
      ('Aprilia', ARRAY['RS660', 'RSV1000', 'RSV4', 'Tuono660', 'Tuono V4', 'Tuono V4 Factory', 'Shiver750', 'Shiver900', 'Dorsoduro750', 'Dorsoduro900', 'Caponord1200', 'Mana850', 'Tuareg660', 'Pegaso650']::text[])
  ),
  source_models AS (
    SELECT source_model_groups.brand, unnest(source_model_groups.models) AS model
    FROM source_model_groups
  ),
  matching_catalog_models AS (
    SELECT DISTINCT catalog.brand, catalog.model
    FROM public.motorcycle_catalog AS catalog
    INNER JOIN source_models AS source
      ON regexp_replace(lower(trim(catalog.brand)), '[^a-z0-9]+', '', 'g') =
         regexp_replace(lower(source.brand), '[^a-z0-9]+', '', 'g')
     AND (
       regexp_replace(lower(trim(catalog.model)), '[^a-z0-9]+', '', 'g') =
         regexp_replace(lower(source.model), '[^a-z0-9]+', '', 'g')
       OR regexp_replace(lower(trim(catalog.model)), '[^a-z0-9]+', '', 'g') =
          regexp_replace(lower(catalog.brand || source.model), '[^a-z0-9]+', '', 'g')
     )
    WHERE catalog.is_active = true
      AND catalog.is_archived = false
  )
  INSERT INTO public.service_model_overrides (
    service_id,
    brand,
    model,
    price,
    duration_minutes
  )
  SELECT
    v_engine_overhaul_id,
    matching_catalog_models.brand,
    matching_catalog_models.model,
    1800.00,
    480
  FROM matching_catalog_models
  ON CONFLICT (service_id, brand, model) DO UPDATE
  SET
    price = EXCLUDED.price,
    duration_minutes = EXCLUDED.duration_minutes
  WHERE public.service_model_overrides.price IS DISTINCT FROM EXCLUDED.price
     OR public.service_model_overrides.duration_minutes IS DISTINCT FROM EXCLUDED.duration_minutes;
END
$$;
