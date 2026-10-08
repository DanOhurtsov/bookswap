'use client'

import type { Me } from '@bookswap/shared'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { VISIBILITY_LABELS } from '../model/profile-form'

type ProfileViewProps = {
  user: Me
  onEdit: () => void
}

/**
 * The saved profile as plain facts — a reading screen, not a form with disabled fields. Email and
 * its verification sit above both modes in `ProfileScreen`: email is not edited here.
 */
export function ProfileView({ user, onEdit }: ProfileViewProps) {
  return (
    <section aria-label="Дані профілю">
      <dl className="facts">
        <dt>Аватар</dt>
        <dd>
          {user.avatarUrl === null ? (
            'Аватар не додано.'
          ) : (
            <Avatar size="lg">
              <AvatarImage src={user.avatarUrl} alt={`Аватар: ${user.displayName}`} />
              <AvatarFallback />
            </Avatar>
          )}
        </dd>

        <dt>Імʼя</dt>
        <dd>{user.displayName}</dd>

        <dt>Про себе</dt>
        <dd className="whitespace-pre-line">{user.bio ?? 'Ще нічого не розповіли.'}</dd>

        <dt>Видимість бібліотеки за замовчуванням</dt>
        <dd>{VISIBILITY_LABELS[user.libraryVisibility]}</dd>

        <dt>Хто читає мої книжки</dt>
        <dd>{user.showHolderNames ? 'Друзі бачать' : 'Друзі не бачать'}</dd>
      </dl>

      <button type="button" onClick={onEdit}>
        Редагувати профіль
      </button>
    </section>
  )
}
