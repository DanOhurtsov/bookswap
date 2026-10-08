/**
 * Side-effect import: must be the FIRST import of a file. Вмикає гостьові позики (синтетично) І
 * реальний поштовий провайдер за конфігурацією (`EMAIL_PROVIDER=resend`) — щоб довести, що гостьовий
 * шлях (D2) не викликає його за жодної конфігурації. Ключ і відправник — вигадані; реальний мережевий
 * виклик у тесті неможливий: `fetch` підмінюється.
 */
import './guest-loans-on'

process.env.EMAIL_PROVIDER = 'resend'
process.env.RESEND_API_KEY = 're_test_synthetic_key'
process.env.EMAIL_FROM = 'BookSwap <noreply@bookswap.invalid>'
