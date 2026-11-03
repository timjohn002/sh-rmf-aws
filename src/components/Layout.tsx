import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { ChangePasswordDialog } from './ChangePasswordDialog'
import { cx } from './ui'

function navClass({ isActive }: { isActive: boolean }) {
  return cx(
    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
    isActive ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white',
  )
}

export function Layout() {
  const { user, logout } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 bg-slate-900 px-3 text-white sm:px-4">
        <img src="/favicon.svg" alt="" className="size-7" />
        <span className="mr-2 hidden font-semibold sm:inline">Starhub RMF</span>
        <nav className="flex gap-1">
          <NavLink to="/" end className={navClass}>
            Map
          </NavLink>
          <NavLink to="/robots" className={navClass}>
            Robots
          </NavLink>
          <NavLink to="/setup" className={navClass}>
            Setup
          </NavLink>
          {user?.role === 'admin' && (
            <>
              <NavLink to="/vendors" className={navClass}>
                Vendors
              </NavLink>
              <NavLink to="/elevators" className={navClass}>
                Elevators
              </NavLink>
              <NavLink to="/users" className={navClass}>
                Users
              </NavLink>
            </>
          )}
        </nav>

        <div ref={menuRef} className="relative ml-auto">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-800"
          >
            <span className="flex size-7 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold uppercase">
              {user?.username.slice(0, 2)}
            </span>
            <span className="hidden sm:inline">{user?.username}</span>
            <span className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-300">
              {user?.role}
            </span>
          </button>
          {menuOpen && (
            <div className="absolute right-0 z-[1500] mt-1 w-48 overflow-hidden rounded-md bg-white py-1 text-sm text-slate-700 shadow-lg ring-1 ring-black/5">
              <button
                type="button"
                className="block w-full px-3 py-2 text-left hover:bg-slate-100"
                onClick={() => {
                  setMenuOpen(false)
                  setPasswordOpen(true)
                }}
              >
                Change password
              </button>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left hover:bg-slate-100"
                onClick={() => logout()}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1">
        <Outlet />
      </main>

      <ChangePasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </div>
  )
}
