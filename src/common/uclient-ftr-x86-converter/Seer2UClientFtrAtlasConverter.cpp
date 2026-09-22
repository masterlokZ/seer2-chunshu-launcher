#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>
#include <wincodec.h>
#include <webp/decode.h>
#include "bcn.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <string>
#include <vector>

#if defined(SEER_CONVERTER_ARCH_X64)
#define SEER_CONVERTER_ARCH_NAME "x64"
#define SEER_CONVERTER_MUTEX_NAME L"Local\\Seer2UCLIENTFTRAtlasConverter-x64-v1"
#else
#define SEER_CONVERTER_ARCH_NAME "x86"
#define SEER_CONVERTER_MUTEX_NAME L"Local\\Seer2UCLIENTFTRAtlasConverter-x86-v1"
#endif

struct Page {
  int index = 0;
  int width = 0;
  int height = 0;
  FILE* file = nullptr;
  std::wstring path;
};

struct Region {
  int index = 0;
  int sourceX = 0;
  int sourceY = 0;
  int width = 0;
  int height = 0;
  int page = 0;
  int destinationX = 0;
  int destinationY = 0;
};

struct MappedFile {
  HANDLE file = INVALID_HANDLE_VALUE;
  HANDLE mapping = nullptr;
  const uint8_t* data = nullptr;
  size_t size = 0;

  ~MappedFile() {
    if (data) UnmapViewOfFile(data);
    if (mapping) CloseHandle(mapping);
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
  }
};

static void fail(const wchar_t* message);

template <typename T>
static void releaseCom(T*& value) {
  if (value) value->Release();
  value = nullptr;
}

static uint8_t roundedDivide(uint32_t value, uint32_t divisor) {
  return static_cast<uint8_t>(std::min<uint32_t>(255u, (value + divisor / 2u) / divisor));
}

enum class NativeAtlasFormat {
  None,
  Bc3,
  Bc7
};

static void decodeNativeBlock(NativeAtlasFormat format, const uint8_t* source, uint32_t* decoded) {
  const int result = format == NativeAtlasFormat::Bc3
    ? decode_bc3(source, 4, 4, decoded)
    : decode_bc7(source, 4, 4, decoded);
  if (result == 0) fail(L"native atlas block decode failed");
}

static void decodeNativeTile(const MappedFile& atlas, NativeAtlasFormat format,
                             int sourceWidth, int sourceHeight,
                             int targetWidth, int targetHeight, int targetX, int targetY,
                             int tileWidth, int tileHeight, std::vector<uint8_t>& tile) {
  if (sourceWidth % targetWidth != 0 || sourceHeight % targetHeight != 0) {
    fail(L"native atlas scale is not integral");
  }
  const int factorX = sourceWidth / targetWidth;
  const int factorY = sourceHeight / targetHeight;
  if (factorX != factorY || (factorX != 1 && factorX != 2 && factorX != 4)) {
    fail(L"native atlas scale must be 1, 0.5 or 0.25");
  }
  const int factor = factorX;
  const int blocksX = (sourceWidth + 3) / 4;
  const int blocksY = (sourceHeight + 3) / 4;
  const int targetBlockEdge = 4 / factor;
  const int firstBlockX = targetX / targetBlockEdge;
  const int lastBlockX = (targetX + tileWidth + targetBlockEdge - 1) / targetBlockEdge;
  const int firstBlockY = targetY / targetBlockEdge;
  const int lastBlockY = (targetY + tileHeight + targetBlockEdge - 1) / targetBlockEdge;
  uint32_t decoded[16]{};
  for (int logicalBlockY = firstBlockY; logicalBlockY < lastBlockY; ++logicalBlockY) {
    if (logicalBlockY < 0 || logicalBlockY >= blocksY) continue;
    const int rawBlockY = blocksY - 1 - logicalBlockY;
    for (int blockX = firstBlockX; blockX < lastBlockX; ++blockX) {
      if (blockX < 0 || blockX >= blocksX) continue;
      const uint64_t blockOffset =
        (static_cast<uint64_t>(rawBlockY) * blocksX + blockX) * 16u;
      if (blockOffset + 16u > atlas.size) fail(L"native atlas block is truncated");
      decodeNativeBlock(format, atlas.data + blockOffset, decoded);
      const int blockTargetX = blockX * targetBlockEdge;
      const int blockTargetY = logicalBlockY * targetBlockEdge;
      for (int outputY = 0; outputY < targetBlockEdge; ++outputY) {
        const int globalY = blockTargetY + outputY;
        if (globalY < targetY || globalY >= targetY + tileHeight || globalY >= targetHeight) continue;
        for (int outputX = 0; outputX < targetBlockEdge; ++outputX) {
          const int globalX = blockTargetX + outputX;
          if (globalX < targetX || globalX >= targetX + tileWidth || globalX >= targetWidth) continue;
          uint32_t alphaSum = 0, redSum = 0, greenSum = 0, blueSum = 0;
          for (int sampleY = 0; sampleY < factor; ++sampleY) {
            const int logicalPixelY = outputY * factor + sampleY;
            const int rawPixelY = 3 - logicalPixelY;
            for (int sampleX = 0; sampleX < factor; ++sampleX) {
              const int rawPixelX = outputX * factor + sampleX;
              const uint32_t pixel = decoded[rawPixelY * 4 + rawPixelX];
              const uint32_t alpha = pixel >> 24;
              alphaSum += alpha;
              redSum += (((pixel >> 16) & 255u) * alpha + 127u) / 255u;
              greenSum += (((pixel >> 8) & 255u) * alpha + 127u) / 255u;
              blueSum += ((pixel & 255u) * alpha + 127u) / 255u;
            }
          }
          const uint32_t sampleCount = static_cast<uint32_t>(factor * factor);
          uint8_t* destination = tile.data() +
            (static_cast<size_t>(globalY - targetY) * tileWidth + globalX - targetX) * 4u;
          destination[0] = roundedDivide(redSum, sampleCount);
          destination[1] = roundedDivide(greenSum, sampleCount);
          destination[2] = roundedDivide(blueSum, sampleCount);
          destination[3] = roundedDivide(alphaSum, sampleCount);
        }
      }
    }
  }
}

static bool writeNativePreviewPng(const MappedFile& atlas, NativeAtlasFormat nativeFormat,
                                  int sourceWidth, int sourceHeight,
                                  int targetWidth, int targetHeight, const std::wstring& target,
                                  uint64_t& outputBytes) {
  if (target.empty() || sourceWidth % targetWidth != 0 || sourceHeight % targetHeight != 0) return false;
  const int factor = sourceWidth / targetWidth;
  if (factor != sourceHeight / targetHeight || (factor != 1 && factor != 2 && factor != 4)) return false;
  HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool uninitialize = SUCCEEDED(initialized);
  IWICImagingFactory* factory = nullptr;
  IWICStream* stream = nullptr;
  IWICBitmapEncoder* encoder = nullptr;
  IWICBitmapFrameEncode* frame = nullptr;
  IPropertyBag2* properties = nullptr;
  bool ok = false;
  std::wstring temporary = target + L".part";
  DeleteFileW(temporary.c_str());
  do {
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(&factory)))) break;
    if (FAILED(factory->CreateStream(&stream)) ||
        FAILED(stream->InitializeFromFilename(temporary.c_str(), GENERIC_WRITE)) ||
        FAILED(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder)) ||
        FAILED(encoder->Initialize(stream, WICBitmapEncoderNoCache)) ||
        FAILED(encoder->CreateNewFrame(&frame, &properties)) ||
        FAILED(frame->Initialize(properties)) ||
        FAILED(frame->SetSize(targetWidth, targetHeight))) break;
    WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
    if (FAILED(frame->SetPixelFormat(&format)) || !IsEqualGUID(format, GUID_WICPixelFormat32bppBGRA)) break;

    const int blocksX = (sourceWidth + 3) / 4;
    const int blocksY = (sourceHeight + 3) / 4;
    std::vector<uint32_t> sourceRows(static_cast<size_t>(sourceWidth) * 4u);
    std::vector<uint8_t> outputRow(static_cast<size_t>(targetWidth) * 4u);
    uint32_t decoded[16]{};
    int writtenRows = 0;
    for (int logicalBlockY = 0; logicalBlockY < blocksY && writtenRows < targetHeight; ++logicalBlockY) {
      const int rawBlockY = blocksY - 1 - logicalBlockY;
      for (int blockX = 0; blockX < blocksX; ++blockX) {
        const uint64_t blockOffset =
          (static_cast<uint64_t>(rawBlockY) * blocksX + blockX) * 16u;
        if (blockOffset + 16u > atlas.size) break;
        decodeNativeBlock(nativeFormat, atlas.data + blockOffset, decoded);
        for (int row = 0; row < 4; ++row) {
          for (int column = 0; column < 4; ++column) {
            const int sourceX = blockX * 4 + column;
            if (sourceX < sourceWidth) {
              sourceRows[static_cast<size_t>(3 - row) * sourceWidth + sourceX] = decoded[row * 4 + column];
            }
          }
        }
      }
      for (int outputWithinBlock = 0; outputWithinBlock < 4 / factor && writtenRows < targetHeight;
           ++outputWithinBlock, ++writtenRows) {
        for (int outputX = 0; outputX < targetWidth; ++outputX) {
          uint32_t alphaSum = 0, redPremultiplied = 0, greenPremultiplied = 0, bluePremultiplied = 0;
          for (int sampleY = 0; sampleY < factor; ++sampleY) {
            const int sourceRow = outputWithinBlock * factor + sampleY;
            for (int sampleX = 0; sampleX < factor; ++sampleX) {
              const uint32_t pixel = sourceRows[static_cast<size_t>(sourceRow) * sourceWidth +
                outputX * factor + sampleX];
              const uint32_t alpha = pixel >> 24;
              alphaSum += alpha;
              redPremultiplied += (((pixel >> 16) & 255u) * alpha + 127u) / 255u;
              greenPremultiplied += (((pixel >> 8) & 255u) * alpha + 127u) / 255u;
              bluePremultiplied += ((pixel & 255u) * alpha + 127u) / 255u;
            }
          }
          const uint32_t samples = static_cast<uint32_t>(factor * factor);
          const uint32_t alpha = roundedDivide(alphaSum, samples);
          const uint32_t red = roundedDivide(redPremultiplied, samples);
          const uint32_t green = roundedDivide(greenPremultiplied, samples);
          const uint32_t blue = roundedDivide(bluePremultiplied, samples);
          uint8_t* destination = outputRow.data() + static_cast<size_t>(outputX) * 4u;
          destination[0] = alpha ? roundedDivide(blue * 255u, alpha) : 0;
          destination[1] = alpha ? roundedDivide(green * 255u, alpha) : 0;
          destination[2] = alpha ? roundedDivide(red * 255u, alpha) : 0;
          destination[3] = static_cast<uint8_t>(alpha);
        }
        if (FAILED(frame->WritePixels(1, targetWidth * 4,
            static_cast<UINT>(outputRow.size()), outputRow.data()))) break;
      }
    }
    if (writtenRows != targetHeight || FAILED(frame->Commit()) || FAILED(encoder->Commit())) break;
    releaseCom(properties);
    releaseCom(frame);
    releaseCom(encoder);
    releaseCom(stream);
    releaseCom(factory);
    if (!MoveFileExW(temporary.c_str(), target.c_str(),
        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) break;
    WIN32_FILE_ATTRIBUTE_DATA attributes{};
    if (!GetFileAttributesExW(target.c_str(), GetFileExInfoStandard, &attributes)) break;
    outputBytes = (static_cast<uint64_t>(attributes.nFileSizeHigh) << 32) | attributes.nFileSizeLow;
    ok = true;
  } while (false);
  releaseCom(properties);
  releaseCom(frame);
  releaseCom(encoder);
  releaseCom(stream);
  releaseCom(factory);
  if (!ok) DeleteFileW(temporary.c_str());
  if (uninitialize) CoUninitialize();
  return ok;
}

static bool existingFileSize(const std::wstring& path, uint64_t& bytes) {
  WIN32_FILE_ATTRIBUTE_DATA attributes{};
  if (path.empty() || !GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &attributes) ||
      (attributes.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) return false;
  bytes = (static_cast<uint64_t>(attributes.nFileSizeHigh) << 32) | attributes.nFileSizeLow;
  return bytes > 0;
}

static void fail(const wchar_t* message) {
  fwprintf(stderr, L"%ls\n", message);
  ExitProcess(2);
}

static std::wstring argument(int argc, wchar_t** argv, const wchar_t* name) {
  for (int i = 1; i + 1 < argc; ++i) {
    if (wcscmp(argv[i], name) == 0) return argv[i + 1];
  }
  return L"";
}

static int integerArgument(int argc, wchar_t** argv, const wchar_t* name, int fallback) {
  std::wstring value = argument(argc, argv, name);
  if (value.empty()) return fallback;
  int parsed = _wtoi(value.c_str());
  return parsed > 0 ? parsed : fallback;
}

static bool mapInput(const std::wstring& path, MappedFile& mapped) {
  mapped.file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (mapped.file == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER length{};
  if (!GetFileSizeEx(mapped.file, &length) || length.QuadPart <= 0 ||
      static_cast<uint64_t>(length.QuadPart) > SIZE_MAX) return false;
  mapped.size = static_cast<size_t>(length.QuadPart);
  mapped.mapping = CreateFileMappingW(mapped.file, nullptr, PAGE_READONLY, 0, 0, nullptr);
  if (!mapped.mapping) return false;
  mapped.data = static_cast<const uint8_t*>(MapViewOfFile(mapped.mapping, FILE_MAP_READ, 0, 0, 0));
  return mapped.data != nullptr;
}

static bool sizeFile(FILE* file, uint64_t bytes) {
  if (!file || bytes == 0) return false;
  if (_fseeki64(file, static_cast<int64_t>(bytes - 1), SEEK_SET) != 0) return false;
  if (fputc(0, file) == EOF) return false;
  return fflush(file) == 0;
}

static bool writeAt(FILE* file, uint64_t offset, const void* data, size_t bytes) {
  if (_fseeki64(file, static_cast<int64_t>(offset), SEEK_SET) != 0) return false;
  return fwrite(data, 1, bytes, file) == bytes;
}

static bool readAt(FILE* file, uint64_t offset, void* data, size_t bytes) {
  if (_fseeki64(file, static_cast<int64_t>(offset), SEEK_SET) != 0) return false;
  return fread(data, 1, bytes, file) == bytes;
}

static uint64_t pixelOffset(const Page& page, int x, int y) {
  return (static_cast<uint64_t>(y) * static_cast<uint64_t>(page.width) +
          static_cast<uint64_t>(x)) * 4u;
}

static bool addPadding(Page& page, const Region& region, int padding) {
  if (padding <= 0 || region.width <= 0 || region.height <= 0) return true;
  uint8_t first[4]{};
  uint8_t last[4]{};
  for (int y = 0; y < region.height; ++y) {
    int py = region.destinationY + y;
    if (!readAt(page.file, pixelOffset(page, region.destinationX, py), first, sizeof(first)) ||
        !readAt(page.file, pixelOffset(page, region.destinationX + region.width - 1, py), last, sizeof(last))) {
      return false;
    }
    for (int edge = 1; edge <= padding; ++edge) {
      if (region.destinationX - edge >= 0 &&
          !writeAt(page.file, pixelOffset(page, region.destinationX - edge, py), first, sizeof(first))) return false;
      if (region.destinationX + region.width - 1 + edge < page.width &&
          !writeAt(page.file, pixelOffset(page, region.destinationX + region.width - 1 + edge, py), last, sizeof(last))) return false;
    }
  }
  std::vector<uint8_t> top(static_cast<size_t>(region.width) * 4u);
  std::vector<uint8_t> bottom(static_cast<size_t>(region.width) * 4u);
  if (!readAt(page.file, pixelOffset(page, region.destinationX, region.destinationY), top.data(), top.size()) ||
      !readAt(page.file, pixelOffset(page, region.destinationX, region.destinationY + region.height - 1),
              bottom.data(), bottom.size())) return false;
  for (int edge = 1; edge <= padding; ++edge) {
    if (region.destinationY - edge >= 0 &&
        !writeAt(page.file, pixelOffset(page, region.destinationX, region.destinationY - edge),
                 top.data(), top.size())) return false;
    if (region.destinationY + region.height - 1 + edge < page.height &&
        !writeAt(page.file, pixelOffset(page, region.destinationX,
                 region.destinationY + region.height - 1 + edge), bottom.data(), bottom.size())) return false;
  }
  return true;
}

int wmain(int argc, wchar_t** argv) {
  SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
  SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);

  // VP8L may keep its LZ77 history addressable even when the requested crop is
  // small. Put a hard ceiling on resident physical memory; Windows can page
  // cold history while the helper remains a short-lived, separate native process.
  const SIZE_T workingSetMinimum = 16u * 1024u * 1024u;
  const SIZE_T workingSetMaximum = 96u * 1024u * 1024u;
  bool workingSetLimited = false;
  HMODULE kernel = GetModuleHandleW(L"kernel32.dll");
  using SetWorkingSetEx = BOOL (WINAPI*)(HANDLE, SIZE_T, SIZE_T, DWORD);
  SetWorkingSetEx setWorkingSetEx = kernel ? reinterpret_cast<SetWorkingSetEx>(
    GetProcAddress(kernel, "SetProcessWorkingSetSizeEx")) : nullptr;
  if (setWorkingSetEx) {
    workingSetLimited = setWorkingSetEx(GetCurrentProcess(), workingSetMinimum,
      workingSetMaximum, 0x00000004u) != FALSE;  // QUOTA_LIMITS_HARDWS_MAX_ENABLE
  } else {
    workingSetLimited = SetProcessWorkingSetSize(GetCurrentProcess(),
      workingSetMinimum, workingSetMaximum) != FALSE;
  }

  // Downloads can be queued from more than one launcher worker. Serialize the
  // memory-heavy native phase across processes without keeping the main UI or
  // Chromium renderer alive. The mutex is architecture-specific so x86 and
  // x64 helpers do not accidentally share a process-wide lock name.
  HANDLE conversionMutex = CreateMutexW(nullptr, FALSE, SEER_CONVERTER_MUTEX_NAME);
  if (!conversionMutex) fail(L"unable to create conversion mutex");
  DWORD mutexWait = WaitForSingleObject(conversionMutex, INFINITE);
  if (mutexWait != WAIT_OBJECT_0 && mutexWait != WAIT_ABANDONED) {
    CloseHandle(conversionMutex);
    fail(L"unable to acquire conversion mutex");
  }

  const std::wstring atlasPath = argument(argc, argv, L"--atlas");
  const std::wstring atlasFormat = argument(argc, argv, L"--atlas-format");
  const std::wstring previewPath = argument(argc, argv, L"--preview");
  const std::wstring planPath = argument(argc, argv, L"--plan");
  const std::wstring outputDirectory = argument(argc, argv, L"--output");
  const std::wstring resultPath = argument(argc, argv, L"--result");
  const int tileEdge = std::max(256, std::min(2048, integerArgument(argc, argv, L"--tile", 1024)));
  if (atlasPath.empty() || planPath.empty() || outputDirectory.empty() || resultPath.empty()) {
    fail(L"usage: --atlas FILE [--atlas-format webp|bc3|bc7] [--preview PNG] --plan FILE --output DIR --result FILE [--tile N]");
  }

  FILE* plan = _wfopen(planPath.c_str(), L"rb");
  if (!plan) fail(L"unable to open conversion plan");
  char signature[32]{};
  if (!fgets(signature, sizeof(signature), plan) || strncmp(signature, "UCLIENTFTRATLAS1", 16) != 0) {
    fclose(plan);
    fail(L"invalid conversion plan signature");
  }
  int sourceWidth = 0, sourceHeight = 0, targetWidth = 0, targetHeight = 0;
  int padding = 0, pageCount = 0, regionCount = 0;
  if (fscanf(plan, "%d %d %d %d %d %d %d", &sourceWidth, &sourceHeight,
             &targetWidth, &targetHeight, &padding, &pageCount, &regionCount) != 7 ||
      sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0 ||
      pageCount <= 0 || pageCount > 64 || regionCount <= 0) {
      fclose(plan);
      fail(L"invalid conversion plan dimensions");
   }
   if (targetWidth != sourceWidth || targetHeight != sourceHeight) {
     fclose(plan);
     fail(L"UCLIENTFTR lossless atlas conversion requires source-size output");
   }

   std::vector<Page> pages(static_cast<size_t>(pageCount));
  for (int i = 0; i < pageCount; ++i) {
    char type = 0;
    Page page{};
    if (fscanf(plan, " %c %d %d %d", &type, &page.index, &page.width, &page.height) != 4 ||
        type != 'P' || page.index != i || page.width <= 0 || page.height <= 0 ||
        page.width > 4095 || page.height > 4095) {
      fclose(plan);
      fail(L"invalid page in conversion plan");
    }
    wchar_t leaf[80]{};
    swprintf(leaf, 80, L"flash-atlas-%d.argb.raw", page.index);
    page.path = outputDirectory + L"\\" + leaf;
    page.file = _wfopen(page.path.c_str(), L"w+b");
    if (!page.file || !sizeFile(page.file, static_cast<uint64_t>(page.width) * page.height * 4u)) {
      fclose(plan);
      fail(L"unable to create raw atlas page");
    }
    pages[static_cast<size_t>(i)] = page;
  }

  std::vector<Region> regions(static_cast<size_t>(regionCount));
  for (int i = 0; i < regionCount; ++i) {
    char type = 0;
    Region region{};
    if (fscanf(plan, " %c %d %d %d %d %d %d %d %d", &type, &region.index,
               &region.sourceX, &region.sourceY, &region.width, &region.height,
               &region.page, &region.destinationX, &region.destinationY) != 9 ||
        type != 'R' || region.index != i || region.page < 0 || region.page >= pageCount ||
        region.width <= 0 || region.height <= 0 || region.sourceX < 0 || region.sourceY < 0 ||
        region.sourceX + region.width > targetWidth || region.sourceY + region.height > targetHeight ||
        region.destinationX < 0 || region.destinationY < 0 ||
        region.destinationX + region.width > pages[region.page].width ||
        region.destinationY + region.height > pages[region.page].height) {
      fclose(plan);
      fail(L"invalid region in conversion plan");
    }
    regions[static_cast<size_t>(i)] = region;
  }
  fclose(plan);

  MappedFile atlas;
  if (!mapInput(atlasPath, atlas)) fail(L"unable to memory-map source atlas");
  const bool isBc7 = _wcsicmp(atlasFormat.c_str(), L"bc7") == 0;
  const bool isBc3 = _wcsicmp(atlasFormat.c_str(), L"bc3") == 0;
  const bool isWebp = atlasFormat.empty() || _wcsicmp(atlasFormat.c_str(), L"webp") == 0;
  const NativeAtlasFormat nativeFormat = isBc3
    ? NativeAtlasFormat::Bc3
    : (isBc7 ? NativeAtlasFormat::Bc7 : NativeAtlasFormat::None);
  const bool isNative = nativeFormat != NativeAtlasFormat::None;
  if (!isNative && !isWebp) fail(L"atlas format must be webp, bc3 or bc7");
  if (isNative) {
    const uint64_t expected = static_cast<uint64_t>((sourceWidth + 3) / 4) *
      static_cast<uint64_t>((sourceHeight + 3) / 4) * 16u;
    if (atlas.size < expected || previewPath.empty()) {
      fail(L"native atlas size or preview target does not match the plan");
    }
  } else {
    WebPBitstreamFeatures features{};
    if (WebPGetFeatures(atlas.data, atlas.size, &features) != VP8_STATUS_OK ||
        features.width != sourceWidth || features.height != sourceHeight || features.has_animation) {
      fail(L"WebP atlas dimensions or format do not match the plan");
    }
  }

  const double scaleX = static_cast<double>(sourceWidth) / targetWidth;
  const double scaleY = static_cast<double>(sourceHeight) / targetHeight;
  int decodedTiles = 0;
  for (int targetY = 0; targetY < targetHeight; targetY += tileEdge) {
    const int tileHeight = std::min(tileEdge, targetHeight - targetY);
    for (int targetX = 0; targetX < targetWidth; targetX += tileEdge) {
      const int tileWidth = std::min(tileEdge, targetWidth - targetX);
      int cropLeft = static_cast<int>(std::floor(targetX * scaleX));
      int cropTop = static_cast<int>(std::floor(targetY * scaleY));
      int cropRight = static_cast<int>(std::ceil((targetX + tileWidth) * scaleX));
      int cropBottom = static_cast<int>(std::ceil((targetY + tileHeight) * scaleY));
      cropLeft &= ~1;
      cropTop &= ~1;
      cropRight = std::min(sourceWidth, cropRight);
      cropBottom = std::min(sourceHeight, cropBottom);
      const int cropWidth = cropRight - cropLeft;
      const int cropHeight = cropBottom - cropTop;

      std::vector<uint8_t> tile(static_cast<size_t>(tileWidth) * tileHeight * 4u);
      if (isNative) {
        decodeNativeTile(atlas, nativeFormat, sourceWidth, sourceHeight,
                         targetWidth, targetHeight, targetX, targetY,
                         tileWidth, tileHeight, tile);
      } else {
        WebPDecoderConfig config{};
        if (!WebPInitDecoderConfig(&config)) fail(L"libwebp decoder ABI mismatch");
        config.options.use_cropping = 1;
        config.options.crop_left = cropLeft;
        config.options.crop_top = cropTop;
        config.options.crop_width = cropWidth;
        config.options.crop_height = cropHeight;
        config.options.use_scaling = (cropWidth != tileWidth || cropHeight != tileHeight) ? 1 : 0;
        config.options.scaled_width = tileWidth;
        config.options.scaled_height = tileHeight;
        config.options.use_threads = 0;
        config.output.colorspace = MODE_rgbA;
        config.output.is_external_memory = 1;
        config.output.u.RGBA.rgba = tile.data();
        config.output.u.RGBA.stride = tileWidth * 4;
        config.output.u.RGBA.size = tile.size();
        VP8StatusCode status = WebPDecode(atlas.data, atlas.size, &config);
        WebPFreeDecBuffer(&config.output);
        if (status != VP8_STATUS_OK) fail(L"libwebp tile decode failed");
      }

      const int tileRight = targetX + tileWidth;
      const int tileBottom = targetY + tileHeight;
      for (const Region& region : regions) {
        const int left = std::max(targetX, region.sourceX);
        const int top = std::max(targetY, region.sourceY);
        const int right = std::min(tileRight, region.sourceX + region.width);
        const int bottom = std::min(tileBottom, region.sourceY + region.height);
        if (left >= right || top >= bottom) continue;
        const int copyWidth = right - left;
        std::vector<uint8_t> argb(static_cast<size_t>(copyWidth) * 4u);
        Page& page = pages[region.page];
        for (int y = top; y < bottom; ++y) {
          const uint8_t* source = tile.data() +
            (static_cast<size_t>(y - targetY) * tileWidth + (left - targetX)) * 4u;
          for (int x = 0; x < copyWidth; ++x) {
            argb[x * 4] = source[x * 4 + 3];
            argb[x * 4 + 1] = source[x * 4];
            argb[x * 4 + 2] = source[x * 4 + 1];
            argb[x * 4 + 3] = source[x * 4 + 2];
          }
          const int destinationX = region.destinationX + left - region.sourceX;
          const int destinationY = region.destinationY + y - region.sourceY;
          if (!writeAt(page.file, pixelOffset(page, destinationX, destinationY), argb.data(), argb.size())) {
            fail(L"unable to write raw atlas pixels");
          }
        }
      }
      ++decodedTiles;
    }
  }

  for (const Region& region : regions) {
    if (!addPadding(pages[region.page], region, padding)) fail(L"unable to add atlas padding");
  }
  for (Page& page : pages) {
    fflush(page.file);
    fclose(page.file);
    page.file = nullptr;
  }

  uint64_t previewBytes = 0;
  if (isNative && !existingFileSize(previewPath, previewBytes) &&
      !writeNativePreviewPng(atlas, nativeFormat, sourceWidth, sourceHeight,
                             targetWidth, targetHeight, previewPath, previewBytes)) {
    fail(L"unable to reuse or write streamed native preview PNG");
  }

  PROCESS_MEMORY_COUNTERS_EX memory{};
  memory.cb = sizeof(memory);
  GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory), sizeof(memory));
  FILE* result = _wfopen(resultPath.c_str(), L"wb");
  if (!result) fail(L"unable to write converter result");
  fprintf(result,
          "{\"ok\":true,\"architecture\":\"%s\",\"sourceWidth\":%d,\"sourceHeight\":%d,"
          "\"targetWidth\":%d,\"targetHeight\":%d,\"tileEdge\":%d,\"decodedTiles\":%d,"
          "\"pages\":%d,\"regions\":%d,\"workingSetLimited\":%s,"
          "\"sourceFormat\":\"%s\",\"previewBytes\":%llu,"
          "\"workingSetMaximumBytes\":%llu,\"peakWorkingSetBytes\":%llu,\"peakPrivateBytes\":%llu}\n",
          SEER_CONVERTER_ARCH_NAME, sourceWidth, sourceHeight, targetWidth, targetHeight, tileEdge, decodedTiles,
          pageCount, regionCount, workingSetLimited ? "true" : "false",
          isBc3 ? "bc3" : (isBc7 ? "bc7" : "webp"),
          static_cast<unsigned long long>(previewBytes),
          static_cast<unsigned long long>(workingSetMaximum),
          static_cast<unsigned long long>(memory.PeakWorkingSetSize),
          static_cast<unsigned long long>(memory.PeakPagefileUsage));
  fclose(result);
  ReleaseMutex(conversionMutex);
  CloseHandle(conversionMutex);
  return 0;
}
