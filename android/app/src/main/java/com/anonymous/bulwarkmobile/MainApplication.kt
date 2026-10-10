package com.anonymous.bulwarkmobile

import android.app.Application
import android.content.res.Configuration

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.internal.featureflags.ReactNativeFeatureFlags
import com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android
import com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsProvider

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ReactNativeHostWrapper

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost = ReactNativeHostWrapper(
      this,
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): MutableList<ReactPackage> {
          val packages: MutableList<ReactPackage> = PackageList(this).packages
          packages.add(BulwarkFcmPackage())
          return packages
        }

          override fun getJSMainModuleName(): String = ".expo/.virtual-metro-entry"

          override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

          override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
      }
  )

  override val reactHost: ReactHost
    get() = ReactNativeHostWrapper.createReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    loadReactNative(this)
    // Text measured at the old system font size is cached by its content, so
    // after a font size change while the app runs, labels laid out again with
    // the same text keep their old width and clip ("M…"). This flag keys the
    // cache on the font scale and re-measures on a change. It is off in
    // RN 0.81's stable set, which load() above just installed; keep that set
    // and turn this one flag on.
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      ReactNativeFeatureFlags.dangerouslyForceOverride(FontScaleLayoutFlags())
    }
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}

private class FontScaleLayoutFlags :
    ReactNativeFeatureFlagsProvider by ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android(
        fabricEnabled = true, bridgelessEnabled = true, turboModulesEnabled = true) {
  override fun enableFontScaleChangesUpdatingLayout(): Boolean = true
}
