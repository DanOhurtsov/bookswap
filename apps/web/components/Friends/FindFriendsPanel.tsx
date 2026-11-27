'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { LinkIcon, SearchIcon } from 'lucide-react'
import { InviteManager } from '@/features/network/index.client'
import { userSearchPageHref } from '@/features/user-search/index.client'

/**
 * «Знайти друзів»: the people search and the invitations. The search itself is `/friends/search`
 * (PO, BS-154): this field opens it with the typed text, so `/friends` sends no search requests.
 * The API matches a name or an exact email, not a nickname, so the field says that. The canvas's
 * «Можливо, ви знайомі» has no API and is not drawn.
 */
function FindFriendsPanel() {
  const router = useRouter()
  const [text, setText] = useState('')

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    router.push(userSearchPageHref(text))
  }

  return (
    <div className="find-friends">
      <section className="find-friends__search" aria-labelledby="find-people-title">
        <h2 id="find-people-title" className="friends-heading">
          Пошук за ім’ям або email
        </h2>
        <form
          role="search"
          aria-label="Пошук людей"
          className="find-friends__form"
          onSubmit={submit}
        >
          <div className="friends-search">
            <SearchIcon className="friends-search__icon" aria-hidden="true" />
            <label htmlFor="find-people-query" className="sr-only">
              Ім’я або email
            </label>
            <input
              id="find-people-query"
              className="friends-search__input"
              type="search"
              name="query"
              autoComplete="off"
              placeholder="Наприклад, Олена або olena@example.com"
              aria-describedby="find-people-hint"
              value={text}
              onChange={(event) => {
                setText(event.target.value)
              }}
            />
          </div>
          <button type="submit" className="friends-button friends-button--primary">
            Знайти
          </button>
        </form>
        <p id="find-people-hint" className="friends-note friends-note--plain">
          Введіть щонайменше 2 символи імені або повну email-адресу.
        </p>
      </section>

      <aside className="find-friends__invite" aria-label="Запрошення">
        <span className="find-friends__invite-icon" aria-hidden="true">
          <LinkIcon />
        </span>
        <InviteManager />
      </aside>
    </div>
  )
}

export { FindFriendsPanel }
