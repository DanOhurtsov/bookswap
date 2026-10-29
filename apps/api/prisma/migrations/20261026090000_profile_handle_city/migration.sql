-- BS-148, підетап A (docs/plan/bs-148-profile-design.md): нік і місто користувача.
--
-- Нік генерує сама база — функція `generate_user_handle()` стоїть у DEFAULT колонки. Тому міграція безпечна
-- для попередньої збірки, що працює під час розгортання: вона вставляє користувачів без ніка, і вставка не
-- падає. Той самий генератор заповнює наявні рядки — двох генераторів (тут і в коді) немає.
--
-- `user` + 8 цифр. Колізію ловить унікальний індекс: реєстрація повторює вставку (auth.service.ts), а backfill
-- нижче перевіряє кожного кандидата сам. Наявні рядки нічого іншого не втрачають: змінюються лише нові колонки.

CREATE FUNCTION generate_user_handle() RETURNS text
  LANGUAGE sql
  VOLATILE
  AS $$ SELECT 'user' || lpad(floor(random() * 100000000)::bigint::text, 8, '0') $$;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "city" TEXT,
ADD COLUMN "handle" TEXT;

-- Наявним користувачам — по ніку, без колізій між собою (по одному: кожен кандидат перевіряється проти вже
-- виданих).
DO $$
DECLARE
  target record;
  candidate text;
BEGIN
  FOR target IN SELECT id FROM "User" WHERE "handle" IS NULL ORDER BY "createdAt", id LOOP
    LOOP
      candidate := generate_user_handle();
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "User" WHERE "handle" = candidate);
    END LOOP;

    UPDATE "User" SET "handle" = candidate WHERE id = target.id;
  END LOOP;
END $$;

ALTER TABLE "User" ALTER COLUMN "handle" SET DEFAULT generate_user_handle(),
ALTER COLUMN "handle" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_handle_key" ON "User"("handle");

-- Формат — той самий, що `HANDLE_RULES` у packages/shared: 3–30 символів, `a–z 0–9`, окремі `-`/`_` між ними.
-- Захищає від запису в обхід API (сиди, ручні правки, майбутній код), а не замінює валідацію запиту.
ALTER TABLE "User"
  ADD CONSTRAINT "user_handle_format"
  CHECK (char_length("handle") BETWEEN 3 AND 30 AND "handle" ~ '^[a-z0-9]+([-_][a-z0-9]+)*$');
