import type { ReactNode } from 'react'

interface ShellProps {
  title: string
  description?: string
  children: ReactNode
  cta?: ReactNode
}

function Shell({ title, description, children, cta }: ShellProps) {
  return (
    <main className="page-container py-10 sm:py-14">
      <header className="mb-8">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
          {cta !== undefined && <div className="mt-4">{cta}</div>}
        </div>
        {description !== undefined && (
          <p className="mt-2 max-w-2xl text-muted-foreground">{description}</p>
        )}
      </header>
      {children}
    </main>
  )
}

export { Shell }
