import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AIRPORT_TAX,
  FACE_PRICE,
  FUEL_EFFECTIVE_DATE,
  FUEL_LONG,
  FUEL_SHORT,
  FUEL_TIER_KM,
  weekendFareEstimate,
} from './weekendFare.js'

test('长途 >800 km：单程 339，往返 678', () => {
  const fare = weekendFareEstimate(801)
  assert.equal(fare.tier, 'long')
  assert.equal(fare.fuel, FUEL_LONG)
  assert.equal(fare.oneWay, FACE_PRICE + FUEL_LONG + AIRPORT_TAX)
  assert.equal(fare.oneWay, 339)
  assert.equal(fare.round, 678)
  assert.match(fare.estimate.text, /单程约 ¥339/)
  assert.match(fare.estimate.text, /往返约 ¥678/)
  assert.match(fare.estimate.text, /燃油 ¥90/)
  assert.match(fare.estimate.text, /机建 ¥50/)
  assert.doesNotMatch(fare.estimate.text, /498/)
  assert.doesNotMatch(fare.fuelLine, /另计/)
  assert.match(fare.fuelLine, /801 km，属长途档/)
})

test('短途 ≤800 km：单程 299，往返 598', () => {
  for (const km of [1, 800]) {
    const fare = weekendFareEstimate(km)
    assert.equal(fare.tier, 'short')
    assert.equal(fare.fuel, FUEL_SHORT)
    assert.equal(fare.oneWay, 299)
    assert.equal(fare.round, 598)
    assert.match(fare.estimate.text, /单程约 ¥299/)
    assert.match(fare.estimate.text, /往返约 ¥598/)
    assert.match(fare.fuelLine, /短途档/)
  }
  assert.equal(weekendFareEstimate(800).distanceKm, FUEL_TIER_KM)
})

test('距离未知时给出短途/长途两档，不再写 498 + 燃油另计', () => {
  for (const km of [0, null, undefined, Number.NaN]) {
    const fare = weekendFareEstimate(km)
    assert.equal(fare.tier, 'unknown')
    assert.equal(fare.oneWay, null)
    assert.equal(fare.oneWayShort, 299)
    assert.equal(fare.oneWayLong, 339)
    assert.equal(fare.roundShort, 598)
    assert.equal(fare.roundLong, 678)
    assert.match(fare.estimate.text, /¥299～¥339/)
    assert.match(fare.estimate.text, /¥598～¥678/)
    assert.match(fare.estimate.text, /短途燃油 ¥50/)
    assert.match(fare.estimate.text, /长途燃油 ¥90/)
    assert.doesNotMatch(fare.estimate.text, /498/)
    assert.doesNotMatch(`${fare.fuelLine} ${fare.estimate.text}`, /另计/)
  }
})

test('燃油费率文案带出票日起和两档金额', () => {
  const fare = weekendFareEstimate(1500)
  assert.match(fare.fuelLine, new RegExp(FUEL_EFFECTIVE_DATE))
  assert.match(fare.fuelLine, /短途（≤800 km）¥50\/程/)
  assert.match(fare.fuelLine, /长途（>800 km）¥90\/程/)
  assert.match(fare.fuelLine, /1500 km/)
})
