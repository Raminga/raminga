package publication

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"net/http"
	"path"
	"strings"
)

const (
	avatarMaxBytes  = 4 << 20
	avatarMaxSide   = 4096
	avatarMaxPixels = 16 * 1000 * 1000
	imageMaxBytes   = 8 << 20
	imageMaxSide    = 8192
	imageMaxPixels  = 32 * 1000 * 1000
)

// ImageError is a bounded, machine-readable image validation failure.
type ImageError struct {
	Code   string
	Reason string
}

func (e *ImageError) Error() string { return e.Reason }

// ValidatedImage is the re-encoded image actually written to public/. EXIF and
// ICC profiles are stripped by the standard-library re-encode.
type ValidatedImage struct {
	Bytes  []byte
	SHA256 string
	Mime   string
	Width  int
	Height int
}

func imageError(code, format string, args ...any) *ImageError {
	return &ImageError{Code: code, Reason: fmt.Sprintf(format, args...)}
}

// ValidateImage sniffs, fully decodes and re-encodes one local image. Only PNG
// and JPEG are accepted; SVG/GIF/WebP are intentionally rejected in P2.
func ValidateImage(data []byte, role, filename string) (ValidatedImage, error) {
	maxBytes, maxSide, maxPixels := int64(imageMaxBytes), imageMaxSide, imageMaxPixels
	isAvatar := role == "avatar" || role == "human_avatar"
	if isAvatar {
		maxBytes, maxSide, maxPixels = avatarMaxBytes, avatarMaxSide, avatarMaxPixels
	}
	if int64(len(data)) == 0 {
		return ValidatedImage{}, imageError("image_decode", "图片为空，无法读取")
	}
	if int64(len(data)) > maxBytes {
		return ValidatedImage{}, imageError("image_size", "图片 %d 字节，超过上限 %d 字节", len(data), maxBytes)
	}
	kind := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(http.DetectContentType(data), "image/")))
	if kind != "png" && kind != "jpeg" {
		return ValidatedImage{}, imageError("image_type", "只支持 PNG 或 JPEG 图片；不支持 SVG、GIF、WebP 或其他格式")
	}
	if ext := strings.ToLower(path.Ext(filename)); ext != "" {
		ok := (kind == "png" && ext == ".png") || (kind == "jpeg" && (ext == ".jpg" || ext == ".jpeg"))
		if !ok {
			return ValidatedImage{}, imageError("image_type", "文件扩展名 %s 与图片内容格式 %s 不一致", ext, kind)
		}
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return ValidatedImage{}, imageError("image_decode", "图片头部损坏或截断，无法读取尺寸")
	}
	if (format == "png" && kind != "png") || (format == "jpeg" && kind != "jpeg") {
		return ValidatedImage{}, imageError("image_type", "图片内容格式与嗅探结果不一致")
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > maxSide || cfg.Height > maxSide {
		return ValidatedImage{}, imageError("image_dimensions", "图片尺寸 %dx%d 超过单边 %d 像素上限", cfg.Width, cfg.Height, maxSide)
	}
	if int64(cfg.Width)*int64(cfg.Height) > int64(maxPixels) {
		return ValidatedImage{}, imageError("image_dimensions", "图片总像素 %d 超过上限 %d", int64(cfg.Width)*int64(cfg.Height), maxPixels)
	}
	decoded, format, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return ValidatedImage{}, imageError("image_decode", "图片内容损坏或截断，无法完整解码")
	}
	bounds := decoded.Bounds()
	if bounds.Dx() != cfg.Width || bounds.Dy() != cfg.Height {
		return ValidatedImage{}, imageError("image_dimensions", "图片解码尺寸与头部声明不一致")
	}
	var out bytes.Buffer
	var mime string
	if isAvatar || format == "png" {
		encoder := png.Encoder{CompressionLevel: png.BestCompression}
		if err := encoder.Encode(&out, decoded); err != nil {
			return ValidatedImage{}, imageError("image_decode", "图片重编码失败：%s", err)
		}
		mime = "image/png"
	} else {
		if err := jpeg.Encode(&out, decoded, &jpeg.Options{Quality: 88}); err != nil {
			return ValidatedImage{}, imageError("image_decode", "图片重编码失败：%s", err)
		}
		mime = "image/jpeg"
	}
	encoded := out.Bytes()
	if int64(len(encoded)) > maxBytes {
		return ValidatedImage{}, imageError("image_size", "重编码后图片 %d 字节，仍超过上限 %d 字节", len(encoded), maxBytes)
	}
	sum := sha256.Sum256(encoded)
	return ValidatedImage{
		Bytes: encoded, SHA256: hex.EncodeToString(sum[:]), Mime: mime,
		Width: bounds.Dx(), Height: bounds.Dy(),
	}, nil
}

// imageExtension returns the canonical extension for a private asset MIME.
func imageExtension(mime string) string {
	if mime == "image/jpeg" {
		return ".jpg"
	}
	return ".png"
}
