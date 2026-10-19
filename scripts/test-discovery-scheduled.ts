import assert from 'node:assert/strict';
import {
  discoveryShanghaiDate,
  isDiscoveryScheduledDate,
  submitScheduledDiscovery,
} from '../src/discovery/scheduled.js';

const dates: Array<[string, boolean]> = [
  ['2026-10-19', false],
  ['2026-10-20', true],
  ['2026-10-21', false],
  ['2026-10-22', true],
  ['2026-10-31', false],
  ['2026-11-01', true],
  ['2026-12-31', true],
  ['2027-01-01', false],
];
for (const timezone of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles']) {
  const previous = process.env.TZ;
  process.env.TZ = timezone;
  try {
    for (const [date, due] of dates) {
      const now = new Date(`${date}T04:00:00Z`);
      assert.equal(discoveryShanghaiDate(now), date);
      assert.equal(isDiscoveryScheduledDate(date), due);
      let calls = 0;
      const logs: string[] = [];
      await submitScheduledDiscovery(
        now,
        async (input) => {
          calls++;
          assert.deepEqual(input, {
            date,
            mode: 'regular',
            triggerSource: 'schedule',
            requestId: `discovery:scheduled:${date}`,
          });
          return { id: 'mock', status: 'pending' } as never;
        },
        (message) => {
          logs.push(message);
        },
      );
      assert.equal(calls, Number(due));
      assert.match(logs[0]!, due ? /mock \(pending\)/ : /skipped/);
    }
    assert.equal(discoveryShanghaiDate(new Date('2026-10-19T15:59:59Z')), '2026-10-19');
    assert.equal(discoveryShanghaiDate(new Date('2026-10-19T16:00:00Z')), '2026-10-20');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}
assert.throws(() => isDiscoveryScheduledDate('2026-02-30'), /Invalid/);
await assert.rejects(
  submitScheduledDiscovery(
    new Date('2026-10-20T04:00:00Z'),
    async () => {
      throw new Error('Mock database failure');
    },
    () => {},
  ),
  /Mock database failure/,
);
console.log(
  'Discovery scheduled calendar, month/year boundaries, Shanghai midnight, timezone independence, skip and submission failure tests passed.',
);
