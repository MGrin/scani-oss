import { z } from 'zod';

/**
 * Chart resolution options
 */
export const ChartResolution = z.enum(['best', 'hourly', 'daily', 'weekly', 'monthly']);
export type ChartResolution = z.infer<typeof ChartResolution>;

/**
 * Input DTO for getting portfolio history events (paginated list)
 */
export const GetPortfolioHistoryEventsInputDto = z.object({
  limit: z.number().min(1).max(100).default(20),
  offset: z.number().min(0).default(0),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export type GetPortfolioHistoryEventsInput = z.infer<typeof GetPortfolioHistoryEventsInputDto>;

/**
 * Input DTO for getting portfolio history chart data
 */
export const GetPortfolioHistoryChartInputDto = z.object({
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  resolution: ChartResolution.default('daily'),
});

export type GetPortfolioHistoryChartInput = z.infer<typeof GetPortfolioHistoryChartInputDto>;

/**
 * Output DTO for portfolio history events
 */
export const PortfolioHistoryEventDto = z.object({
  timestamp: z.date(),
  eventType: z.enum(['holding_update', 'price_update']),
  holdingId: z.string().optional(),
  tokenId: z.string(),
  tokenSymbol: z.string(),
  tokenName: z.string(),
  balance: z.string(),
  price: z.string(),
  value: z.string(),
  baseCurrencySymbol: z.string(),
});

export type PortfolioHistoryEvent = z.infer<typeof PortfolioHistoryEventDto>;

/**
 * Output DTO for portfolio history events list
 */
export const GetPortfolioHistoryEventsOutputDto = z.object({
  events: z.array(PortfolioHistoryEventDto),
  total: z.number(),
  hasMore: z.boolean(),
});

export type GetPortfolioHistoryEventsOutput = z.infer<typeof GetPortfolioHistoryEventsOutputDto>;

/**
 * Output DTO for portfolio history chart data
 */
export const PortfolioHistoryChartDataDto = z.object({
  timestamp: z.date(),
  totalValue: z.string(),
  holdingsCount: z.number(),
});

export type PortfolioHistoryChartData = z.infer<typeof PortfolioHistoryChartDataDto>;

export const GetPortfolioHistoryChartOutputDto = z.array(PortfolioHistoryChartDataDto);

export type GetPortfolioHistoryChartOutput = z.infer<typeof GetPortfolioHistoryChartOutputDto>;
