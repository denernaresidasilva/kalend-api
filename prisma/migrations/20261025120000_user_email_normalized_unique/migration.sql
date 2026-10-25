-- Stop safely if old rows already represent the same normalized identity.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User"
    GROUP BY lower(btrim(email))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add normalized email uniqueness while duplicate identities exist';
  END IF;
END
$$;

CREATE UNIQUE INDEX "User_email_normalized_key"
  ON "User" (lower(btrim(email)));
