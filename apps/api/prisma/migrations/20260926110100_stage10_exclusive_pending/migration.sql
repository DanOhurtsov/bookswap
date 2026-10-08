-- Stage 10, крок 10e, M5 (docs/plan/stage-10-real-world-history.md, §6.2, §6.13, MIG3, C1).
--
-- `PENDING_CONFIRMATION` (запис власника, що чекає відповіді позичальника) стає ексклюзивним станом:
-- на одному примірнику не може бути двох записів, а також запису й `APPROVED`/`HANDED_OVER`.
-- Предикат лише РОЗШИРЮЄТЬСЯ: значення `PENDING_CONFIRMATION` з'явилося в 10a, але до цього кроку жоден
-- рядок його не мав, тож індекс будується на наявних даних без порушень. Жодного `Copy`/`Loan` не читає
-- й не змінює. Частковий індекс, тож Prisma про нього не знає (як і в першій міграції).
DROP INDEX "one_active_loan_per_copy";

CREATE UNIQUE INDEX "one_active_loan_per_copy"
  ON "Loan" ("copyId")
  WHERE status IN ('APPROVED', 'HANDED_OVER', 'PENDING_CONFIRMATION');
