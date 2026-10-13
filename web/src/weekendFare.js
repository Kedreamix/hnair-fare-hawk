/**
 * 会员卡兑换费用参考（成人、国内航线）。
 *
 * 票面 FACE_PRICE 只服务这块展示。监控任务的 target_price 仍默认 199，改费率时不要动后端阈值。
 * 燃油附加费按出票日：2026-10-10 起短途（≤800 km）¥50、长途（>800 km）¥90。
 * 2026-08 至 2026-09 的 ¥40 / ¥70 已过期。
 * 民航发展基金（机建）成人国内典型航线仍为 ¥50/程。
 */
export const FACE_PRICE = 199
export const FUEL_SHORT = 50
export const FUEL_LONG = 90
export const AIRPORT_TAX = 50
export const FUEL_TIER_KM = 800
export const FUEL_EFFECTIVE_DATE = '2026-10-10'

function allIn(fuel) {
  return FACE_PRICE + fuel + AIRPORT_TAX
}

export function weekendFareEstimate(distanceKm) {
  const km = Number(distanceKm)
  const distance = Number.isFinite(km) ? Math.round(km) : 0
  const known = distance > 0
  const long = known && distance > FUEL_TIER_KM
  const tier = !known ? 'unknown' : (long ? 'long' : 'short')
  const fuel = tier === 'long' ? FUEL_LONG : (tier === 'short' ? FUEL_SHORT : null)
  const oneWayShort = allIn(FUEL_SHORT)
  const oneWayLong = allIn(FUEL_LONG)
  const roundShort = oneWayShort * 2
  const roundLong = oneWayLong * 2
  const oneWay = fuel == null ? null : allIn(fuel)
  const round = oneWay == null ? null : oneWay * 2
  const routeNote = tier === 'unknown'
    ? ''
    : `。本航线约 ${distance} km，属${tier === 'long' ? '长途' : '短途'}档`
  const fuelLine = `燃油附加费：自 ${FUEL_EFFECTIVE_DATE} 出票，短途（≤${FUEL_TIER_KM} km）¥${FUEL_SHORT}/程，长途（>${FUEL_TIER_KM} km）¥${FUEL_LONG}/程${routeNote}`
  const estimate = tier === 'unknown'
    ? {
      lead: `单程 ¥${oneWayShort}～¥${oneWayLong}，往返 `,
      highlight: `¥${roundShort}～¥${roundLong}`,
      tail: `（距离未知，短途燃油 ¥${FUEL_SHORT} / 长途燃油 ¥${FUEL_LONG}，均含机建 ¥${AIRPORT_TAX}）`,
    }
    : {
      lead: `单程约 ¥${oneWay}，往返约 `,
      highlight: `¥${round}`,
      tail: `（票面 ¥${FACE_PRICE} + 燃油 ¥${fuel} + 机建 ¥${AIRPORT_TAX}）`,
    }
  return {
    distanceKm: known ? distance : 0,
    tier,
    fuel,
    oneWay,
    round,
    oneWayShort,
    oneWayLong,
    roundShort,
    roundLong,
    faceRound: FACE_PRICE * 2,
    airportRound: AIRPORT_TAX * 2,
    fuelLine,
    estimate: { ...estimate, text: `${estimate.lead}${estimate.highlight}${estimate.tail}` },
  }
}
