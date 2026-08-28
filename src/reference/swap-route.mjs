import { parseAbi } from "viem";
import { PANCAKESWAP_V3 } from "./pancakeswap.mjs";

/**
 * Moving between two stablecoins is a real cost, and the honest way to price it
 * is to ask the venue. A direct pool can be far worse than a routed path, so
 * both are quoted and the better one is used; pricing a move off a bad route
 * would reject a good opportunity for the wrong reason.
 */
export const QUOTER_SINGLE_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
export const QUOTER_PATH_ABI = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);

export const STABLE_FEE_TIERS = Object.freeze([100, 500]);

export function encodePath(tokens, fees) {
  if (tokens.length !== fees.length + 1) throw new Error("A V3 path needs one more token than it has fees.");
  let path = "0x";
  for (let index = 0; index < fees.length; index += 1) {
    path += tokens[index].slice(2).toLowerCase() + Number(fees[index]).toString(16).padStart(6, "0");
  }
  return path + tokens[tokens.length - 1].slice(2).toLowerCase();
}

/** Cost of a swap as a fraction of the input. Negative means the swap is favourable. */
export function swapCostFraction({ amountIn, amountOut }) {
  const input = Number(amountIn);
  if (!(input > 0)) return null;
  return (input - Number(amountOut)) / input;
}

/**
 * Quote a direct swap and a routed swap through an intermediary, and report
 * both plus which is better. `null` routes are recorded as unavailable rather
 * than treated as infinitely expensive.
 */
export async function quoteReallocationRoutes({ publicClient, tokenIn, tokenOut, amountIn, intermediaries = [], feeTiers = STABLE_FEE_TIERS, quoter = PANCAKESWAP_V3.quoterV2, blockNumber } = {}) {
  const options = { blockNumber: blockNumber === undefined ? undefined : BigInt(blockNumber) };
  const routes = [];

  for (const fee of feeTiers) {
    try {
      const result = await publicClient.simulateContract({ address: quoter, abi: QUOTER_SINGLE_ABI, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn: BigInt(amountIn), fee, sqrtPriceLimitX96: 0n }], ...options });
      routes.push({ kind: "direct", hops: [tokenIn, tokenOut], fees: [fee], amountOut: result.result[0].toString(), ticksCrossed: Number(result.result[2]), costFraction: swapCostFraction({ amountIn, amountOut: result.result[0] }), available: true });
    } catch (error) {
      routes.push({ kind: "direct", hops: [tokenIn, tokenOut], fees: [fee], available: false, reason: (error.shortMessage || error.message || "quote reverted").slice(0, 120) });
    }
  }

  for (const middle of intermediaries) {
    for (const feeA of feeTiers) {
      for (const feeB of feeTiers) {
        try {
          const path = encodePath([tokenIn, middle, tokenOut], [feeA, feeB]);
          const result = await publicClient.simulateContract({ address: quoter, abi: QUOTER_PATH_ABI, functionName: "quoteExactInput", args: [path, BigInt(amountIn)], ...options });
          routes.push({ kind: "routed", hops: [tokenIn, middle, tokenOut], fees: [feeA, feeB], amountOut: result.result[0].toString(), ticksCrossed: result.result[2].reduce((total, value) => total + Number(value), 0), costFraction: swapCostFraction({ amountIn, amountOut: result.result[0] }), available: true });
        } catch (error) {
          routes.push({ kind: "routed", hops: [tokenIn, middle, tokenOut], fees: [feeA, feeB], available: false, reason: (error.shortMessage || error.message || "quote reverted").slice(0, 120) });
        }
      }
    }
  }

  const usable = routes.filter((route) => route.available && Number.isFinite(route.costFraction));
  const best = usable.length ? usable.reduce((cheapest, route) => (route.costFraction < cheapest.costFraction ? route : cheapest)) : null;
  return {
    tokenIn,
    tokenOut,
    amountIn: String(amountIn),
    quoter,
    routes,
    bestRoute: best,
    bestCostFraction: best ? best.costFraction : null,
    routesQuoted: routes.length,
    routesAvailable: usable.length,
    note: "Direct and routed quotes are both recorded. A direct pool can be far worse than a routed path, so the cheaper one prices the move.",
  };
}

/** Gas cost of a declared transaction sequence, priced at the frozen gas price. */
export function reallocationGasCost({ gasPriceWei, steps }) {
  const totalGas = steps.reduce((total, step) => total + BigInt(step.gasUnits), 0n);
  const weiCost = totalGas * BigInt(gasPriceWei);
  return {
    steps,
    totalGasUnits: totalGas.toString(),
    gasPriceWei: String(gasPriceWei),
    gasCostWei: weiCost.toString(),
    gasCostNative: Number(weiCost) / 1e18,
  };
}
