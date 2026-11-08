import { formatDate } from '@/app/lib/labels'
import { ME, loanOf } from '../loans.test-helpers'
import { toLoanPageView } from './loan-page-view'
import { statusExplanationOf } from './loan-status'

type Facts = Omit<Parameters<typeof loanOf>[0], 'id' | 'title' | 'authors'>

const view = (facts: Facts) =>
  toLoanPageView(
    loanOf({ id: 'l', title: '1984', authors: ['Джордж Орвелл'], year: 2021, ...facts }),
    ME.id,
  )

describe('сторінка однієї позики: шапка, деталі, повідомлення (BS-153)', () => {
  it('роль — з позики, яку дав сервер: власник бачить позичальника, позичальник — власника', () => {
    expect(view({ side: 'lent' })).toMatchObject({
      role: 'owner',
      relation: 'У мене позичає',
      counterpart: { name: 'Олесь', href: '/u/oles', role: 'Позичальник' },
      book: { title: '1984', authors: 'Джордж Орвелл', href: '/works/work-l' },
    })
    expect(view({ side: 'borrowed' })).toMatchObject({
      role: 'borrower',
      relation: 'Я позичаю',
      counterpart: { name: 'Марта Ковалів', href: '/u/marta', role: 'Власник' },
    })
  })

  it('бейдж — той самий, що в рядку списку; прострочення — з isOverdue', () => {
    expect(view({ side: 'lent', isOverdue: true, dueAt: '2026-10-20' }).badge).toEqual({
      label: 'Прострочено',
      tone: 'over',
      tip: statusExplanationOf('OVERDUE'),
    })
  })

  it('завершена позика названа так само, як у «Історії», і веде туди', () => {
    expect(view({ side: 'borrowed', status: 'RETURNED' })).toMatchObject({
      relation: 'Ви позичили',
      listTab: 'history',
    })
    expect(view({ side: 'lent' }).listTab).toBe('owner')
    expect(view({ side: 'borrowed', status: 'APPROVED' }).listTab).toBe('borrower')
  })

  it('деталі — лише відомі факти; строк до відповіді — це побажання позичальника', () => {
    expect(
      view({ side: 'lent', status: 'REQUESTED', dueAt: '2026-12-01', handedAt: null }).facts,
    ).toEqual([
      { label: 'Бажаний строк', value: formatDate('2026-12-01') },
      { label: 'Запит надіслано', value: formatDate('2026-10-01T09:00:00.000Z') },
      { label: 'Видання', value: 'Мʼяка обкладинка · 2021' },
      { label: 'Стан примірника', value: 'Добрий стан' },
    ])
    expect(view({ side: 'lent' }).facts[0]).toEqual({
      label: 'Строк повернення',
      value: 'Не вказано',
    })
  })

  it('записана власником позика — без «Запит надіслано»: запиту не було', () => {
    const labels = view({ side: 'lent', origin: 'RECORDED_EXISTING' }).facts.map(
      ({ label }) => label,
    )

    expect(labels).toContain('Записано власником')
    expect(labels).not.toContain('Запит надіслано')
  })

  it('повідомлення до запиту й відповідь власника — лише якщо вони є', () => {
    expect(view({ side: 'lent' }).messages).toEqual([])
    expect(
      view({ side: 'lent', message: 'Можна на тиждень?', responseNote: 'Так' }).messages,
    ).toEqual([
      {
        key: 'message',
        heading: 'Повідомлення до запиту',
        text: 'Можна на тиждень?',
        byline: `Олесь · ${formatDate('2026-10-01T09:00:00.000Z')}`,
      },
      {
        key: 'response',
        heading: 'Відповідь власника',
        text: 'Так',
        byline: `Ви · ${formatDate('2026-10-02T09:00:00.000Z')}`,
      },
    ])
  })
})
