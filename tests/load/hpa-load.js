// =============================================================================
// Sustained load test for the API autoscaler (HPA), run with k6.
//
//   brew install k6
//   BASE_URL=https://stocksync.online DEMO_PASSWORD='...' k6 run tests/load/hpa-load.js
//   (or: docker run --rm -i -e BASE_URL -e DEMO_PASSWORD grafana/k6 run - < tests/load/hpa-load.js)
//
// Watch it scale in a second terminal:
//   kubectl -n stocksync get hpa api -w
//
// Two scenarios run together for about 8 minutes:
//   * "browse": staff reading inventory, low stock and history (many small requests)
//   * "login":  a steady stream of sign-ins; bcrypt hashing is deliberately
//               CPU-heavy, so this is what pushes API CPU above the HPA target
// The test only READS and logs in: it never sells or restocks, so stock and the
// audit history are unchanged. Successful logins are not counted by the login
// rate limiter, so it does not block the test.
//
// Correctness is tested separately (tests/concurrency-test.mjs): a short burst
// proves transactions, but only SUSTAINED load moves the HPA, which averages
// CPU over time.
// =============================================================================
import http from "k6/http";
import { check, fail, sleep } from "k6";

const BASE = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const PASSWORD = __ENV.DEMO_PASSWORD;
const VUS = Number(__ENV.VUS || 40);              // concurrent "browse" users at peak
const LOGINS_PER_SEC = Number(__ENV.LOGIN_RATE || 4);
const HOLD = __ENV.HOLD || "5m";                  // how long to hold peak load

export const options = {
  scenarios: {
    browse: {
      executor: "ramping-vus",
      exec: "browse",
      startVUs: 0,
      stages: [
        { duration: "1m", target: VUS },          // ramp up
        { duration: HOLD, target: VUS },          // sustained load: the HPA reacts here
        { duration: "1m", target: 0 },            // ramp down
      ],
    },
    login: {
      executor: "constant-arrival-rate",
      exec: "login",
      rate: LOGINS_PER_SEC,
      timeUnit: "1s",
      duration: "7m",
      startTime: "30s",
      preAllocatedVUs: 20,
      maxVUs: 60,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],               // < 1% errors, even while pods are added
    "http_req_duration{scenario:browse}": ["p(95)<1500"],
  },
};

function signIn(email) {
  return http.post(
    `${BASE}/api/auth/login`,
    JSON.stringify({ email, password: PASSWORD }),
    { headers: { "content-type": "application/json" }, tags: { name: "login" } },
  );
}

export function setup() {
  if (!PASSWORD) fail("Set DEMO_PASSWORD to the demo accounts' password");
  const res = signIn("staff.dt@stocksync.dev");
  if (res.status !== 200) fail(`setup login failed: HTTP ${res.status}`);
  return { token: res.json("token") };
}

export function browse({ token }) {
  const params = { headers: { authorization: `Bearer ${token}` } };
  const responses = http.batch([
    ["GET", `${BASE}/api/products`, null, { ...params, tags: { name: "products" } }],
    ["GET", `${BASE}/api/stock`, null, { ...params, tags: { name: "stock" } }],
    ["GET", `${BASE}/api/low-stock`, null, { ...params, tags: { name: "low-stock" } }],
    ["GET", `${BASE}/api/movements?limit=50`, null, { ...params, tags: { name: "movements" } }],
  ]);
  for (const r of responses) check(r, { "browse 200": (x) => x.status === 200 });
  sleep(0.5);
}

const ACCOUNTS = ["staff.dt@stocksync.dev", "staff.ny@stocksync.dev",
                  "manager.dt@stocksync.dev", "manager.ny@stocksync.dev"];

export function login() {
  const res = signIn(ACCOUNTS[Math.floor(Math.random() * ACCOUNTS.length)]);
  check(res, { "login 200": (r) => r.status === 200 });
}
