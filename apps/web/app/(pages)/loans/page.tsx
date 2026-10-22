import { LoansScreen } from '@/features/loans/index.client'

/**
 * §1.1 and §2.2: the route composes, nothing else. The tab, the history side and a single loan are
 * all read from the query string inside the screen (BS-143), so the route takes no parameters.
 */
export default function LoansPage() {
  return <LoansScreen />
}
