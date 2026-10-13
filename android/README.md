# Murmur for Android

A small native app that opens the Murmur player (the GitHub Pages copy, which connects to your server through `config.js`). It adds phone features on top of the web app:

- picking files from the phone for uploads and "Bring into Murmur"
- **Save file to device**, which saves into `Downloads/Murmur`
- the back gesture moves back inside Murmur, and from Home it sends the app to the background instead of closing it
- music keeps playing when you switch apps or flip the phone open or closed

## Build

Needs Android Studio installed (for its Java and the Android SDK).

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
cd android
.\gradlew.bat assembleRelease
```

The APK is written to `app/build/outputs/apk/release/app-release.apk`.

## Signing

Release builds are signed with `murmur-release.jks` using the passwords in `keystore.properties`. Both are kept only on this computer and are ignored by git. **Back them up.** Without them, a new version can't install over the old one; you'd have to uninstall first, which also clears downloads on the phone.

To make a new key:

```powershell
& "C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe" -genkeypair -keystore murmur-release.jks -storetype PKCS12 -alias murmur -keyalg RSA -keysize 2048 -validity 10000
```

Then put this in `keystore.properties`:

```
storeFile=murmur-release.jks
storePassword=...
keyAlias=murmur
keyPassword=...
```

## Updating the app

Most changes need no new APK, because the app loads the player from GitHub Pages. Only changes to the files in this folder need a rebuild. To release one, raise `versionCode` in `app/build.gradle`, then rebuild.
