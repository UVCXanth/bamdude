/**
 * Why an estimate is not whole — the server's two closed lists of codes, in the order
 * a surface lists them (WS-13 E1). The label of each is `projects.estimateReasons.<code>`
 * in both locales; `locales.test.ts` pins both lists to the backend's and to the keys.
 *
 * - An order's production estimate (`OrderForecast.incomplete_reasons`, OR5a):
 *   `backend/app/services/farm_forecast.py::REASON_ORDER`.
 * - One standard unit of a product (`ProductEstimate.reasons`, ES3):
 *   `backend/app/api/routes/products.py::_ESTIMATE_REASONS`.
 */
export const ORDER_ESTIMATE_REASONS = [
  'unknown_time',
  'unroutable',
  'material_mismatch',
  'needs_slicing',
  'no_plate',
  'truncated',
] as const;

export const PRODUCT_ESTIMATE_REASONS = [
  'no_plate',
  'needs_slicing',
  'unknown_time',
  'unknown_weight',
  'unknown_purchase_price',
  'truncated',
  'empty_composition',
] as const;
