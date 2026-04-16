import { describe, expect, it, mock } from 'bun:test';
import { IbkrFlexQueryService } from './IbkrFlexQueryService';

// The IBKR service uses fetchWithTimeout from @scani/core, which internally calls fetch.
// We mock globalThis.fetch so fetchWithTimeout's underlying fetch is mocked.
const originalFetch = globalThis.fetch;

describe('IbkrFlexQueryService', () => {
  const service = new IbkrFlexQueryService();

  describe('requestReport', () => {
    it('should POST to FlexStatementService.SendRequest and extract ReferenceCode', async () => {
      const xmlResponse = `
        <FlexStatementResponse>
          <Status>Success</Status>
          <ReferenceCode>REF123456</ReferenceCode>
        </FlexStatementResponse>
      `;

      globalThis.fetch = mock(() => Promise.resolve(new Response(xmlResponse, { status: 200 })));

      const refCode = await service.requestReport('test-token', 'query-123');
      expect(refCode).toBe('REF123456');

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      const url = call![0] as string;
      expect(url).toContain('FlexStatementService.SendRequest');
      const options = call![1] as RequestInit;
      expect(options.method).toBe('POST');
      const headers = options.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(options.body).toContain('t=test-token');
      expect(options.body).toContain('q=query-123');
      expect(options.body).toContain('v=3');

      globalThis.fetch = originalFetch;
    });

    it('should throw when response contains ErrorCode', async () => {
      const xmlResponse = `
        <FlexStatementResponse>
          <ErrorCode>1018</ErrorCode>
          <ErrorMessage>Invalid token</ErrorMessage>
        </FlexStatementResponse>
      `;

      globalThis.fetch = mock(() => Promise.resolve(new Response(xmlResponse, { status: 200 })));

      expect(service.requestReport('bad-token', 'query-123')).rejects.toThrow(
        'IBKR Flex Query error (code 1018): Invalid token'
      );

      globalThis.fetch = originalFetch;
    });

    it('should throw when ReferenceCode is missing', async () => {
      const xmlResponse = `
        <FlexStatementResponse>
          <Status>Success</Status>
        </FlexStatementResponse>
      `;

      globalThis.fetch = mock(() => Promise.resolve(new Response(xmlResponse, { status: 200 })));

      expect(service.requestReport('test-token', 'query-123')).rejects.toThrow(
        'missing ReferenceCode'
      );

      globalThis.fetch = originalFetch;
    });

    it('should throw on HTTP error', async () => {
      globalThis.fetch = mock(() => Promise.resolve(new Response('Server Error', { status: 500 })));

      expect(service.requestReport('test-token', 'query-123')).rejects.toThrow(
        'IBKR SendRequest failed with HTTP 500'
      );

      globalThis.fetch = originalFetch;
    });
  });

  describe('parseFlexQueryXml', () => {
    it('should parse OpenPosition and CashReportCurrency elements from XML', () => {
      const xml = `
        <FlexQueryResponse>
          <FlexStatements>
            <FlexStatement>
              <OpenPositions>
                <OpenPosition symbol="AAPL" description="Apple Inc" position="100" markPrice="175.50" positionValue="17550" currency="USD" assetCategory="STK" listingExchange="NASDAQ" />
                <OpenPosition symbol="XEQT" description="iShares Core Equity ETF" position="50" markPrice="30.00" positionValue="1500" currency="CAD" assetCategory="STK" listingExchange="TSE" />
                <OpenPosition symbol="ZERO" description="Zero Position" position="0" markPrice="100" positionValue="0" currency="USD" assetCategory="STK" listingExchange="NYSE" />
              </OpenPositions>
              <CashReport>
                <CashReportCurrency currency="USD" endingCash="25000.50" />
                <CashReportCurrency currency="EUR" endingCash="5000.00" />
                <CashReportCurrency currency="GBP" endingCash="0" />
              </CashReport>
            </FlexStatement>
          </FlexStatements>
        </FlexQueryResponse>
      `;

      const result = service.parseFlexQueryXml(xml);

      // Should exclude zero position
      expect(result.positions).toHaveLength(2);
      expect(result.positions[0]!.symbol).toBe('AAPL');
      expect(result.positions[0]!.position).toBe('100');
      expect(result.positions[0]!.markPrice).toBe('175.50');
      expect(result.positions[0]!.positionValue).toBe('17550');
      expect(result.positions[0]!.currency).toBe('USD');
      expect(result.positions[0]!.assetCategory).toBe('STK');
      expect(result.positions[0]!.listingExchange).toBe('NASDAQ');
      expect(result.positions[1]!.symbol).toBe('XEQT');
      expect(result.positions[1]!.currency).toBe('CAD');
      expect(result.positions[1]!.listingExchange).toBe('TSE');

      // Should exclude zero cash balance
      expect(result.cashBalances).toHaveLength(2);
      expect(result.cashBalances[0]!.currency).toBe('USD');
      expect(result.cashBalances[0]!.endingCash).toBe('25000.50');
      expect(result.cashBalances[1]!.currency).toBe('EUR');
    });

    it('should filter out BASE_SUMMARY cash rows', () => {
      const xml = `
        <FlexQueryResponse>
          <FlexStatements>
            <FlexStatement>
              <OpenPositions></OpenPositions>
              <CashReport>
                <CashReportCurrency currency="USD" endingCash="10000.00" />
                <CashReportCurrency currency="BASE_SUMMARY" endingCash="10000.00" />
              </CashReport>
            </FlexStatement>
          </FlexStatements>
        </FlexQueryResponse>
      `;

      const result = service.parseFlexQueryXml(xml);
      expect(result.cashBalances).toHaveLength(1);
      expect(result.cashBalances[0]!.currency).toBe('USD');
    });

    it('should fall back to endingSettledCash when endingCash is missing', () => {
      const xml = `
        <FlexQueryResponse>
          <FlexStatements>
            <FlexStatement>
              <OpenPositions></OpenPositions>
              <CashReport>
                <CashReportCurrency currency="USD" endingSettledCash="7500.25" />
              </CashReport>
            </FlexStatement>
          </FlexStatements>
        </FlexQueryResponse>
      `;

      const result = service.parseFlexQueryXml(xml);
      expect(result.cashBalances).toHaveLength(1);
      expect(result.cashBalances[0]!.currency).toBe('USD');
      expect(result.cashBalances[0]!.endingCash).toBe('7500.25');
    });

    it('should return empty arrays for XML with no positions or cash', () => {
      const xml = `
        <FlexQueryResponse>
          <FlexStatements>
            <FlexStatement>
              <OpenPositions></OpenPositions>
              <CashReport></CashReport>
            </FlexStatement>
          </FlexStatements>
        </FlexQueryResponse>
      `;

      const result = service.parseFlexQueryXml(xml);
      expect(result.positions).toHaveLength(0);
      expect(result.cashBalances).toHaveLength(0);
    });
  });

  describe('validateCredentials', () => {
    it('should return true when requestReport succeeds', async () => {
      const xmlResponse = `
        <FlexStatementResponse>
          <Status>Success</Status>
          <ReferenceCode>REF789</ReferenceCode>
        </FlexStatementResponse>
      `;

      globalThis.fetch = mock(() => Promise.resolve(new Response(xmlResponse, { status: 200 })));

      const result = await service.validateCredentials('valid-token', 'query-123');
      expect(result).toBe(true);
      globalThis.fetch = originalFetch;
    });

    it('should return false when requestReport fails (error code)', async () => {
      const xmlResponse = `
        <FlexStatementResponse>
          <ErrorCode>1018</ErrorCode>
          <ErrorMessage>Invalid token</ErrorMessage>
        </FlexStatementResponse>
      `;

      globalThis.fetch = mock(() => Promise.resolve(new Response(xmlResponse, { status: 200 })));

      const result = await service.validateCredentials('bad-token', 'query-123');
      expect(result).toBe(false);
      globalThis.fetch = originalFetch;
    });

    it('should return false on network error', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('Network error')));

      const result = await service.validateCredentials('any-token', 'any-query');
      expect(result).toBe(false);
      globalThis.fetch = originalFetch;
    });
  });
});
