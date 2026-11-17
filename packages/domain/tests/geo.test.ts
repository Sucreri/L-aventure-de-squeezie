import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pointInPolygon, haversineM, type GeoJsonPolygon } from '../src/geo.ts';

// The Biéreau rectangle used by the demo data.
const biereau: GeoJsonPolygon = {
  type: 'Polygon',
  coordinates: [[
    [4.6100, 50.6650], [4.6220, 50.6650],
    [4.6220, 50.6720], [4.6100, 50.6720], [4.6100, 50.6650],
  ]],
};

describe('appartenance à une zone — §6.3', () => {
  test('un point au centre du quartier est dedans', () => {
    assert.equal(pointInPolygon({ lat: 50.6685, lon: 4.6160 }, biereau), true);
  });

  test('un point nettement en dehors est refusé', () => {
    assert.equal(pointInPolygon({ lat: 50.8500, lon: 4.3500 }, biereau), false,
      'Bruxelles ne fait pas partie de la zone de service');
  });

  test('un point juste au nord est dehors', () => {
    assert.equal(pointInPolygon({ lat: 50.6730, lon: 4.6160 }, biereau), false);
  });

  test('un point juste à l\'ouest est dehors', () => {
    assert.equal(pointInPolygon({ lat: 50.6685, lon: 4.6050 }, biereau), false);
  });

  test('un polygone invalide ne contient rien', () => {
    const degenerate: GeoJsonPolygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] };
    assert.equal(pointInPolygon({ lat: 0.5, lon: 0.5 }, degenerate), false);
  });
});

describe('distances', () => {
  test('la distance à soi-même est nulle', () => {
    assert.equal(haversineM({ lat: 50.6695, lon: 4.6145 }, { lat: 50.6695, lon: 4.6145 }), 0);
  });

  test('une distance dans Louvain-la-Neuve est de l\'ordre de quelques centaines de mètres', () => {
    const d = haversineM({ lat: 50.6690, lon: 4.6150 }, { lat: 50.6700, lon: 4.6200 });
    assert.ok(d > 300 && d < 450, `obtenu ${d} m`);
  });

  test('la distance est symétrique', () => {
    const a = { lat: 50.6690, lon: 4.6150 };
    const b = { lat: 50.6715, lon: 4.6280 };
    assert.equal(haversineM(a, b).toFixed(6), haversineM(b, a).toFixed(6));
  });

  test('un degré de latitude vaut environ 111 km', () => {
    const d = haversineM({ lat: 50, lon: 4 }, { lat: 51, lon: 4 });
    assert.ok(Math.abs(d - 111_195) < 500, `obtenu ${d} m`);
  });
});
