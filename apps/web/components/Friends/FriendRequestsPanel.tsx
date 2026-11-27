import type { FriendRequest } from '@bookswap/shared'
import { IncomingRequestRow, OutgoingRequestRow } from '@/components/Friends/FriendRequestRow'
import type { IncomingRow } from '@/components/Friends/friends-view'

interface FriendRequestsPanelProps {
  incoming: IncomingRow[]
  outgoing: FriendRequest[]
  busyKey: string | undefined
  onRespond: (request: FriendRequest, action: 'accept' | 'decline') => void
  onCancelRequest: (request: FriendRequest) => void
}

/** «Запити»: who wants to add you, then whom you asked. Each list says so when it is empty. */
function FriendRequestsPanel({
  incoming,
  outgoing,
  busyKey,
  onRespond,
  onCancelRequest,
}: FriendRequestsPanelProps) {
  return (
    <div className="friend-requests">
      <section className="friend-requests__section" aria-labelledby="incoming-requests-title">
        <h2 id="incoming-requests-title" className="friends-heading">
          Хочуть додати вас
        </h2>
        {incoming.length === 0 ? (
          <p className="friends-note">Нових запитів немає.</p>
        ) : (
          <ul className="request-rows">
            {incoming.map((row) => (
              <IncomingRequestRow
                key={row.request.id}
                row={row}
                busyKey={busyKey}
                onAccept={() => {
                  onRespond(row.request, 'accept')
                }}
                onDecline={() => {
                  onRespond(row.request, 'decline')
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="friend-requests__section" aria-labelledby="outgoing-requests-title">
        <h2 id="outgoing-requests-title" className="friends-heading">
          Ви надіслали
        </h2>
        {outgoing.length === 0 ? (
          <p className="friends-note">Ви не чекаєте відповіді на жоден запит.</p>
        ) : (
          <ul className="request-rows">
            {outgoing.map((request) => (
              <OutgoingRequestRow
                key={request.id}
                request={request}
                busyKey={busyKey}
                onCancel={() => {
                  onCancelRequest(request)
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export { FriendRequestsPanel }
