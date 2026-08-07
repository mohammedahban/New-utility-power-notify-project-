# Add project specific ProGuard rules here.

# react-native-reanimated
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# Stripe - keep ALL Stripe classes
-keep class com.stripe.android.** { *; }
-keep class com.reactnativestripesdk.** { *; }
-keep interface com.stripe.android.** { *; }

# OkHttp (used by Stripe)
-keep class okhttp3.** { *; }
-keep interface okhttp3.** { *; }

# Suppress warnings for Stripe classes that may not be present
-dontwarn com.stripe.android.**
-dontwarn com.reactnativestripesdk.**
-dontwarn okhttp3.**

# Add any project specific keep options here:
