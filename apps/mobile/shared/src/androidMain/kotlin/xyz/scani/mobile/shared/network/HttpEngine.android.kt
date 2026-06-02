package xyz.scani.mobile.shared.network

import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.okhttp.OkHttp

actual fun defaultHttpEngine(): HttpClientEngine = OkHttp.create()
