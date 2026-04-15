import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const networkPath = path.join(root, 'public', 'data', 'norta-network.json');
const outputPath = path.join(root, 'public', 'data', 'vehicle-positions.json');

const network = JSON.parse(fs.readFileSync(networkPath, 'utf8'));
const timestamp = Math.floor(Date.now() / 1000);

const entities = network.routes.map((route, index) => {
  const progress = Number((((index * 0.173) % 1) * 0.82 + 0.08).toFixed(3));
  const progressRate = Number((0.0007 + ((index % 5) * 0.00008)).toFixed(5));

  return {
    id: `veh-${route.id}-01`,
    vehicle: {
      trip: {
        route_id: route.id,
        trip_id: `demo-${route.id}-01`,
      },
      vehicle: {
        id: `veh-${route.id}-01`,
      },
      position: {
        progress,
        progressRate,
      },
      timestamp,
    },
  };
});

fs.writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      header: {
        gtfs_realtime_version: '2.0',
        timestamp,
      },
      entity: entities,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`Wrote ${entities.length} demo vehicles to ${outputPath}`);
