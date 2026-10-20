# Microsoft's open-source MSIX Packaging SDK ("makemsix") with packing support, pinned to a
# reviewed commit. Ubuntu 24.04: ICU 74 still builds with the SDK's C++14 sources (ICU 75+ needs C++17);
# the SDK needs CMake 3.29+, newer than Ubuntu's, so CMake comes from PyPI.
FROM ubuntu:24.04
ARG MSIX_COMMIT=25a65f5c1690930813bcc10cdf1d59fa865f2bb1
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git ca-certificates make clang libicu-dev zlib1g-dev python3-pip && \
    pip3 install --break-system-packages --no-cache-dir cmake==3.31.6 && \
    git clone https://github.com/microsoft/msix-packaging.git /src && cd /src && git checkout "$MSIX_COMMIT" && \
    mkdir .vs && cd .vs && \
    cmake -DCMAKE_BUILD_TYPE=MinSizeRel -DSKIP_BUNDLES=on -DUSE_VALIDATION_PARSER=on -DCMAKE_TOOLCHAIN_FILE=../cmake/linux.cmake \
      -DMSIX_PACK=on -DMSIX_SAMPLES=off -DMSIX_TESTS=off -DLINUX=on .. && \
    make -j"$(nproc)" && \
    install -m 755 bin/makemsix /usr/local/bin/makemsix && install -m 644 lib/libmsix.so /usr/local/lib/libmsix.so && ldconfig && \
    install -D -m 644 /src/LICENSE /usr/share/doc/msix-packaging/LICENSE && \
    cd / && rm -rf /src && pip3 uninstall -y --break-system-packages cmake && apt-get purge -y git make clang python3-pip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["makemsix"]
