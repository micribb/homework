plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.stepcam.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.stepcam.app"
        minSdk = 26
        // 33 keeps the USB-permission broadcast behaviour the UVC library expects.
        targetSdk = 33
        versionCode = 3
        versionName = "1.2"
    }

    // A fixed key (committed on purpose) so every new build installs over the previous one.
    signingConfigs {
        create("stepcam") {
            storeFile = file("stepcam.keystore")
            storePassword = "stepcam123"
            keyAlias = "stepcam"
            keyPassword = "stepcam123"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("stepcam")
        }
        debug {
            signingConfig = signingConfigs.getByName("stepcam")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }

    packaging {
        jniLibs { useLegacyPackaging = true }
    }
}

dependencies {
    // USB Video Class (UVC) driver: talks to the Logitech webcam over USB OTG without root.
    implementation("com.herohan:UVCAndroid:1.0.13")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.core:core-ktx:1.13.1")
}
