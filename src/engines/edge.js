import { evaluateScalpDetails } from "./scalpStrategy.js";

// Wrapper to maintain some semblance of structure, but really just proxies to scalpStrategy
export function decide(context) {
  // context should match what evaluateScalpDetails expects
  return evaluateScalpDetails(context);
}

export function computeEdge({ modelUp, modelDown, marketYes, marketNo }) {
    // Keep this helper if needed for logging/display, but strategy ignores it mostly (uses raw odds)
  if (marketYes === null || marketNo === null) {
    return { marketUp: null, marketDown: null, edgeUp: null, edgeDown: null };
  }

  const sum = marketYes + marketNo;
  const marketUp = sum > 0 ? marketYes / sum : null;
  const marketDown = sum > 0 ? marketNo / sum : null;

  const edgeUp = marketUp === null ? null : modelUp - marketUp;
  const edgeDown = marketDown === null ? null : modelDown - marketDown;

  return {
    marketUp, // raw prob
    marketDown,
    edgeUp, // vs model
    edgeDown
  };
}
