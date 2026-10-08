-- Stage 10, крок 10c, M3 (docs/plan/stage-10-real-world-history.md, §6.13, DEL4).
--
-- `Loan.copyId → Copy`: `CASCADE` → `RESTRICT`. Каскад стирав історію позичань разом із
-- примірником (§4.6: історія живе лише в `Loan`). Після зміни `DELETE FROM "Copy"` падає, доки в
-- примірника є хоч один `Loan`. Жоден наявний рядок `Copy`/`Loan` не змінюється й не видаляється:
-- міграція торкається лише правила на майбутнє. Примірники, вже втрачені старим каскадом, цією
-- міграцією не відновлюються.

-- DropForeignKey
ALTER TABLE "Loan" DROP CONSTRAINT "Loan_copyId_fkey";

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_copyId_fkey" FOREIGN KEY ("copyId") REFERENCES "Copy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
