/**
 * @scani/providers
 *
 * One package for every external-service integration: pricing (current
 * + historical), balances, transactions, AI inference, token identity,
 * credential validation. Replaces the historical split across
 * @scani/integrations + @scani/pricing-providers + @scani/ai-providers.
 *
 * Architecture:
 *   - `core/` — capability interfaces, registry, types, errors, base
 *     classes, cloud-mode adapters, testing helpers, boot factory.
 *   - `providers/<name>/` — one directory per integration (24 today).
 *     Each implements zero or more capability interfaces. New providers
 *     drop in as a new directory; nothing else changes.
 *
 * Apps consume this package via `buildProviderRegistry({ ... })` from
 * `core/boot.ts` — single boot call returns a fully-wired
 * `ProviderRegistry` for the requested deployment mode (direct or
 * cloud).
 */

export * from './core';
