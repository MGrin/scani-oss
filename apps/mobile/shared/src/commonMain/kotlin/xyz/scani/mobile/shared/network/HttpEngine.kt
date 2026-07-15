package xyz.scani.mobile.shared.network

import io.ktor.client.engine.HttpClientEngine

// Platform default Ktor engine, so platform code (incl. Swift) builds the API
// clients without referencing engine-specific factories.
expect fun defaultHttpEngine(): HttpClientEngine
