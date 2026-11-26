FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/ndk/26.1.10909125:$PATH

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip wget openjdk-17-jdk-headless cmake python3 git \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p "$ANDROID_HOME/cmdline-tools" \
 && curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -o /tmp/cmdline-tools.zip \
 && unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline-tools-unpack \
 && mv /tmp/cmdline-tools-unpack/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest" \
 && rm -rf /tmp/cmdline-tools.zip /tmp/cmdline-tools-unpack

RUN yes | sdkmanager --licenses > /dev/null 2>&1 || true \
 && sdkmanager --install \
      "platform-tools" \
      "platforms;android-34" \
      "platforms;android-35" \
      "build-tools;34.0.0" \
      "build-tools;35.0.0" \
      "cmake;3.22.1" \
      "ndk;26.1.10909125"

RUN npm install -g eas-cli

WORKDIR /app

ENV PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/ndk/26.1.10909125:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
