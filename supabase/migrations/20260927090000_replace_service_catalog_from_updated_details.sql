-- Replace the active service catalog with Motorcycle_Service_Details_Updated.pdf.
-- Preserve the Engine Overhaul record so its existing model-specific prices stay
-- attached to the same service ID and historical bookings retain their snapshots.

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
    RAISE EXCEPTION 'Engine Overhaul service is required before replacing the service catalog';
  END IF;

  -- Archive rather than delete legacy services. This preserves foreign-key
  -- relationships and the price/duration snapshots on historical appointments.
  UPDATE public.services
  SET
    is_active = false,
    is_archived = true,
    archived_at = COALESCE(archived_at, now())
  WHERE id <> v_engine_overhaul_id
    AND (is_active = true OR is_archived = false);

  -- Non-Engine-Overhaul overrides belong to the retired catalog and must not
  -- remain available to the booking or price-management flows.
  DELETE FROM public.service_model_overrides
  WHERE service_id <> v_engine_overhaul_id;

  -- Keep Engine Overhaul in the source document's relative display position
  -- without changing its preserved default price, duration, or model overrides.
  UPDATE public.services
  SET sort_order = 340
  WHERE id = v_engine_overhaul_id;

  WITH replacement_services (
    name,
    description,
    price,
    duration_minutes,
    category,
    sort_order
  ) AS (
    VALUES
      ('Change Oil', 'Drains old engine oil and refills the engine with the correct oil to reduce friction and protect moving parts.', 50.00, 60, 'maintenance', 10),
      ('Motorcycle Tune-Up', 'Checks basic engine and performance items for rough running, difficult starting, reduced power, or rideability concerns.', 150.00, 150, 'maintenance', 20),
      ('Brake Service', 'Inspects braking concerns and carries out routine brake work where practical; additional confirmed work may require more time or cost.', 50.00, 90, 'brakes', 30),
      ('Clutch Adjustment', 'Adjusts clutch control and checks operation for difficult shifting, incorrect lever feel, or poor engagement.', 50.00, 75, 'drivetrain', 40),
      ('Full CVT Service', 'Inspects and cleans serviceable automatic-CVT components, checks their condition, and reports worn parts billed separately.', 500.00, 210, 'drivetrain', 50),
      ('Chain Cleaning', 'Cleans dirt, dust, and sticky buildup from the drive chain and checks its general condition.', 50.00, 75, 'drivetrain', 60),
      ('Chain Lubrication', 'Applies suitable lubricant to a dry, squeaky, or noisy drive chain to support smooth operation and reduce wear.', 50.00, 70, 'drivetrain', 70),
      ('Chain Adjustment', 'Adjusts drive-chain slack and checks rear-wheel alignment for a chain that is too loose, too tight, or noisy.', 50.00, 75, 'drivetrain', 80),
      ('Chain Replacement', 'Installs a compatible replacement chain, adjusts tension, and checks operation; the chain itself may be billed separately.', 100.00, 90, 'drivetrain', 90),
      ('Sprocket Replacement', 'Replaces a worn or damaged sprocket and checks the drive-chain fit.', 100.00, 90, 'drivetrain', 100),
      ('Chain and Sprocket Replacement', 'Replaces worn or damaged chain and sprockets as a set, adjusts tension, and checks alignment; parts may be billed separately.', 150.00, 120, 'drivetrain', 110),
      ('Tire Change', 'Removes a tire and fits a compatible replacement; tires, tubes, and other parts may be billed separately.', 70.00, 90, 'tires', 120),
      ('Tire Balancing', 'Checks and balances the wheel to address vibration caused by uneven weight, where suitable equipment is available.', 50.00, 75, 'tires', 130),
      ('Wheel Alignment', 'Checks wheel alignment and makes supported adjustments when the motorcycle does not track straight.', 50.00, 75, 'tires', 140),
      ('Wheel Bearing Replacement', 'Checks wheel operation and replaces confirmed worn or damaged bearings.', 50.00, 120, 'tires', 150),
      ('Front Fork Service', 'Inspects and services front forks for leaks, noise, poor damping, or incorrect feel, including seal replacement where appropriate.', 150.00, 150, 'suspension', 160),
      ('Rear Shock Service', 'Checks and services the rear shock where its design supports servicing; replacement may be required for some units.', 100.00, 120, 'suspension', 170),
      ('Suspension Tuning', 'Checks available suspension settings and adjusts them where the motorcycle supports adjustment.', 200.00, 90, 'suspension', 180),
      ('Suspension Rebuild', 'Disassembles, checks, and rebuilds a serviceable worn or leaking suspension unit; additional parts or work may be needed.', 150.00, 210, 'suspension', 190),
      ('Steering Bearing Replacement', 'Checks steering bearings and replaces worn bearings that cause stiffness, looseness, catching, or knocking.', 250.00, 210, 'suspension', 200),
      ('Battery Testing', 'Tests battery charge retention and identifies whether further charging-system checks are needed.', 20.00, 60, 'electrical', 210),
      ('Battery Replacement', 'Installs a compatible replacement battery after confirming a failed or unreliable battery; the battery cost may be separate.', 50.00, 75, 'electrical', 220),
      ('Electrical Diagnostics FI', 'Checks relevant electrical connections and components for fuel-injected motorcycles with warning lights, starting trouble, or intermittent functions.', 150.00, 120, 'electrical', 230),
      ('Electrical Wiring Repair', 'Checks related wiring and connections and repairs accessible electrical faults; difficult faults may take longer.', 200.00, 150, 'electrical', 240),
      ('ECU Diagnostic Scan', 'Scans compatible motorcycles for stored error codes and explains what the results may indicate.', 250.00, 90, 'electrical', 250),
      ('Spark Plug Replacement', 'Checks and replaces a compatible spark plug for hard starting, uneven running, or misfiring.', 50.00, 75, 'engine', 260),
      ('Air Filter Replacement', 'Accesses the filter housing and installs a suitable replacement filter when needed.', 50.00, 75, 'engine', 270),
      ('Carburetor Cleaning', 'Cleans serviceable carburetor passages and components for hard starting, stalling, uneven idle, or poor running.', 100.00, 120, 'engine', 280),
      ('Carburetor Tuning', 'Checks and adjusts carburetor settings for rough idle or poor running; worn parts may require separate work.', 100.00, 90, 'engine', 290),
      ('Throttle Body Cleaning', 'Cleans the throttle body and accessible air passages on fuel-injected motorcycles; injector cleaning is separate work.', 250.00, 120, 'engine', 300),
      ('Fuel System Cleaning', 'Checks and cleans fuel-delivery components included in the shop procedure; injector removal may be separate work.', 100.00, 120, 'engine', 310),
      ('Radiator Cleaning', 'Carefully cleans external radiator fins to remove dirt, leaves, or mud that can restrict airflow.', 100.00, 90, 'engine', 320),
      ('Engine Diagnostic', 'Performs appropriate checks and tests to identify the cause of engine noise, power loss, rough running, smoke, or similar concerns.', 150.00, 120, 'engine', 330),
      ('Motorcycle General Inspection', 'Checks key areas including brakes, tires, lights, chain, fluid levels, and visible leaks, then explains recommended next steps.', 500.00, 90, 'inspection', 350),
      ('Headlight/Lighting Replacement', 'Checks the bulb and basic connection, then replaces a faulty compatible lighting component when needed; parts may be separate.', 250.00, 75, 'electrical', 360),
      ('Starter System Diagnosis & Repair', 'Checks battery connections, starter relay, wiring, and starter motor for clicking, no-start, or intermittent-starting concerns.', 150.00, 120, 'electrical', 370),
      ('Charging System Repair', 'Checks and repairs a faulty charging-system connection or serviceable component; parts may be separate.', 100.00, 150, 'electrical', 380),
      ('Charging System Testing', 'Tests the battery and charging output to determine whether the motorcycle is charging correctly.', 100.00, 75, 'electrical', 390),
      ('Horn Replacement', 'Checks the horn and its connection, then replaces a faulty compatible horn when needed; the replacement part may be separate.', 100.00, 75, 'electrical', 400),
      ('Fuel Pump Inspection/Repair', 'Checks the fuel pump and related connections for hard starting, stalling, or suspected fuel-delivery faults.', 100.00, 120, 'engine', 410),
      ('Water Pump Inspection/Repair', 'Inspects the water pump and related parts for coolant leaks or overheating and recommends repair or replacement as needed.', 200.00, 150, 'engine', 420),
      ('Transmission Repair', 'Diagnoses difficult shifting, gear slipping, and abnormal drivetrain noises; major internal repairs can take longer and cost more.', 250.00, 270, 'drivetrain', 430),
      ('Brake Shoe Replacement', 'Removes the wheel, replaces worn drum-brake shoes, and adjusts the drum for proper stopping performance.', 70.00, 90, 'brakes', 440),
      ('Brake Pad Replacement', 'Replaces worn disc-brake pads and checks disc condition before reassembly.', 50.00, 75, 'brakes', 450),
      ('Magneto Cleaning', 'Cleans magneto ignition contacts and components and checks ignition output for hard starting, weak spark, or rough idle.', 50.00, 60, 'engine', 460),
      ('Crankshaft Bearing Replacement', 'Opens the crankcase, inspects the crankshaft assembly, and replaces worn main bearings; additional internal parts may be needed.', 700.00, 300, 'engine', 470),
      ('CVT Roller / Fly Weight Replacement', 'Opens the CVT cover, replaces worn rollers or fly weights, and checks belt condition.', 150.00, 105, 'drivetrain', 480),
      ('Handlebar Switch Replacement', 'Checks switch wiring and replaces a faulty handlebar switch assembly for affected horn, signal, lighting, or starter controls.', 100.00, 75, 'electrical', 490),
      ('Throttle Cable Replacement/Adjustment', 'Adjusts or replaces a stiff, sticky, loose, or slow-returning throttle cable and checks smooth operation.', 50.00, 60, 'engine', 500),
      ('Muffler/Exhaust Replacement', 'Removes and installs a compatible muffler or exhaust, then checks for leaks; the replacement part may be separate.', 100.00, 90, 'engine', 510),
      ('Racing Carburetor Installation', 'Installs and base-tunes a customer-supplied performance carburetor; additional fine-tuning may require a follow-up visit.', 300.00, 150, 'upgrades', 520),
      ('Frame/Crash Slider Installation', 'Fits and secures customer-supplied frame or swingarm sliders to the appropriate mounting points.', 100.00, 60, 'upgrades', 530),
      ('Fan Spinner Installation', 'Fits and secures a customer-supplied decorative fan spinner on the front-wheel axle.', 50.00, 30, 'upgrades', 540),
      ('Accessory/Upgrade Parts Installation General', 'Fits and secures other customer-supplied accessories or upgrades, such as mirrors, guards, grips, or lighting kits.', 0.00, 120, 'upgrades', 550)
  )
  INSERT INTO public.services (
    name,
    description,
    price,
    duration_minutes,
    category,
    is_active,
    is_archived,
    archived_at,
    sort_order
  )
  SELECT
    name,
    description,
    price,
    duration_minutes,
    category,
    true,
    false,
    NULL,
    sort_order
  FROM replacement_services
  ON CONFLICT (name) DO UPDATE
  SET
    description = EXCLUDED.description,
    price = EXCLUDED.price,
    duration_minutes = EXCLUDED.duration_minutes,
    category = EXCLUDED.category,
    is_active = true,
    is_archived = false,
    archived_at = NULL,
    sort_order = EXCLUDED.sort_order;
END
$$;
