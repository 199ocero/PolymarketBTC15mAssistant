import { fetchWithTimeout } from "../src/utils.js";

async function testTimeout() {
  console.log("Testing fetchWithTimeout with a very short timeout (10ms)...");
  try {
    // This should definitely timeout
    await fetchWithTimeout("https://httpbin.org/delay/5", { timeout: 10 });
    console.log("Error: Request should have timed out!");
    process.exit(1);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log("Success: Request timed out as expected.");
    } else {
      console.log("Unexpected error:", err);
      process.exit(1);
    }
  }

  console.log("Testing fetchWithTimeout with a sufficient timeout (10s)...");
  try {
    const res = await fetchWithTimeout("https://httpbin.org/get", { timeout: 10000 });
    if (res.ok) {
      console.log("Success: Request completed within timeout.");
    } else {
      console.log("Error: Request failed with status", res.status);
      process.exit(1);
    }
  } catch (err) {
    console.log("Error: Request should not have timed out!", err);
    process.exit(1);
  }
}

testTimeout();
