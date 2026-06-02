package xyz.scani.mobile.android.screens

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

fun syncStatusLabel(lastSyncedAtMillis: Long?): String =
    if (lastSyncedAtMillis == null) "Never synced"
    else "Last synced: ${SimpleDateFormat("MMM d, HH:mm", Locale.getDefault()).format(Date(lastSyncedAtMillis))}"
