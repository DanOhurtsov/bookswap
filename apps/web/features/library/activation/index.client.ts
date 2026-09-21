'use client'

/**
 * Client entry of the activation feature: the checklist itself, plus the one
 * thing other features need from it — a way to say «copies changed» without
 * spelling out the query key (CONVENTIONS.md §1.3, R12).
 */
export { ActivationChecklist } from './components/ActivationChecklist'
export { ACTIVATION_QUERY_KEY, invalidateActivation } from './model/activation-query'
