import type { Route } from './app'
import auth from './api/auth'
import floors from './api/floors'
import keenonMaps from './api/keenon-maps'
import map from './api/map'
import robots from './api/robots'
import users from './api/users'
import vendorWebhook from './api/vendor-webhook'
import vendors from './api/vendors'

/** Every API route. Each handler is called with the named path segments as `params`. */
export const ROUTES: Route[] = [
  { paths: ['/api/auth/:action'], handler: auth },
  { paths: ['/api/users', '/api/users/:id', '/api/users/:id/password'], handler: users },
  { paths: ['/api/floors', '/api/floors/:id', '/api/floors/:id/plan-upload-url'], handler: floors },
  { paths: ['/api/map/robots'], handler: map },
  { paths: ['/api/robots', '/api/robots/vendors/:vendor/refresh'], handler: robots },
  { paths: ['/api/vendors/:vendor/webhook/:token'], handler: vendorWebhook },
  {
    paths: ['/api/vendors', '/api/vendors/:vendor', '/api/vendors/:vendor/:action', '/api/vendor-events/:id'],
    handler: vendors,
  },
  {
    paths: [
      '/api/keenon/robots',
      '/api/keenon/robots/:id/:action',
      '/api/keenon/stores/:id/scenes',
      '/api/keenon/robot-floors/:id',
      '/api/keenon/robot-floors/:id/:action',
    ],
    handler: keenonMaps,
  },
]
