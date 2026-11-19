package publication

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Raminga/raminga/internal/storage"
)

var (
	sourcePostV1Path = regexp.MustCompile(`^posts/[A-Za-z0-9._-]+\.json$`)
	sourcePostV2Path = regexp.MustCompile(`^posts/[A-Za-z0-9._-]+/post\.json$`)
	sourcePostID     = regexp.MustCompile(`^[a-z0-9-]{1,128}$`)
)

// sourcePost is one existing local public post parsed for controlled editing.
// raw keeps every unknown top-level field so publication can merge updates
// without dropping compatibility data written by older clients or Agent tools.
type sourcePost struct {
	path          string
	raw           map[string]json.RawMessage
	schemaVersion int
	id            string
	title         string
	body          string
	tags          []string
	publishedAt   string
	updatedAt     string
	revision      int64
	author        postAuthorJSON
	authorKind    string
	images        []postImageJSON
}

func decodeOptionalString(raw json.RawMessage, field string) (string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("%w: %s 必须是字符串", ErrDraftInvalid, field)
	}
	return value, nil
}

func decodeOptionalObject(raw json.RawMessage, field string) (map[string]json.RawMessage, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, fmt.Errorf("%w: 缺少 %s", ErrDraftInvalid, field)
	}
	var value map[string]json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		return nil, fmt.Errorf("%w: %s 必须是对象", ErrDraftInvalid, field)
	}
	return value, nil
}

// ValidVersionedPostPath reports whether rel is one of the two public post
// paths accepted by publication and favorites.
func ValidVersionedPostPath(rel string) (int, bool) {
	return validSourcePostPath(rel)
}

func validSourcePostPath(rel string) (int, bool) {
	switch {
	case sourcePostV2Path.MatchString(rel):
		return 2, true
	case sourcePostV1Path.MatchString(rel):
		return 1, true
	default:
		return 0, false
	}
}

func parseSourcePost(rel string, data []byte, localPeerID string) (*sourcePost, error) {
	schema, ok := validSourcePostPath(rel)
	if !ok {
		return nil, fmt.Errorf("%w: 只能编辑本机 posts/*.json 或 posts/*/post.json", ErrDraftInvalid)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil || raw == nil {
		return nil, fmt.Errorf("%w: 公开动态不是有效 JSON 对象", ErrDraftInvalid)
	}
	var schemaVersion int
	if err := json.Unmarshal(raw["schema_version"], &schemaVersion); err != nil || schemaVersion != schema {
		return nil, fmt.Errorf("%w: 公开动态 schema_version 与路径不一致", ErrDraftInvalid)
	}
	var format string
	if err := json.Unmarshal(raw["format"], &format); err != nil || format != "markdown" {
		return nil, fmt.Errorf("%w: 公开动态 format 必须为 markdown", ErrDraftInvalid)
	}
	title, err := decodeOptionalString(raw["title"], "title")
	if err != nil {
		return nil, err
	}
	title = strings.TrimSpace(title)
	if title == "" {
		return nil, fmt.Errorf("%w: 公开动态缺少标题", ErrDraftInvalid)
	}
	maxTitle := MaxTitleRunes
	if schema == 1 {
		maxTitle = 200
	}
	if utf8.RuneCountInString(title) > maxTitle {
		return nil, fmt.Errorf("%w: 公开动态标题超过 %d 字符", ErrDraftInvalid, maxTitle)
	}
	body, err := decodeOptionalString(raw["body"], "body")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(body) == "" {
		return nil, fmt.Errorf("%w: 公开动态正文为空", ErrDraftInvalid)
	}
	if len([]byte(body)) > MaxBodyBytes {
		return nil, fmt.Errorf("%w: 公开动态正文超过 64 KiB", ErrDraftInvalid)
	}
	authorRaw, err := decodeOptionalObject(raw["author"], "author")
	if err != nil {
		return nil, err
	}
	peerID, err := decodeOptionalString(authorRaw["peer_id"], "author.peer_id")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(peerID) == "" || strings.TrimSpace(peerID) != strings.TrimSpace(localPeerID) {
		return nil, fmt.Errorf("%w: 只能编辑本机发布且作者声明匹配的公开动态", ErrDraftInvalid)
	}
	kind, err := decodeOptionalString(authorRaw["kind"], "author.kind")
	if err != nil {
		return nil, err
	}
	if kind != storage.DraftAuthorUser && kind != storage.DraftAuthorAgent {
		return nil, fmt.Errorf("%w: 公开动态来源未明确（author.kind 必须为 user 或 agent），不能安全导入编辑", ErrDraftInvalid)
	}
	displayName, err := decodeOptionalString(authorRaw["display_name"], "author.display_name")
	if err != nil {
		return nil, err
	}
	publishedAt, err := decodeOptionalString(raw["published_at"], "published_at")
	if err != nil {
		return nil, err
	}
	if _, parseErr := time.Parse(time.RFC3339, publishedAt); parseErr != nil {
		return nil, fmt.Errorf("%w: 公开动态 published_at 不是 RFC 3339", ErrDraftInvalid)
	}
	updatedAt, err := decodeOptionalString(raw["updated_at"], "updated_at")
	if err != nil {
		return nil, err
	}
	var tags []string
	if len(raw["tags"]) > 0 && string(raw["tags"]) != "null" {
		if err := json.Unmarshal(raw["tags"], &tags); err != nil {
			return nil, fmt.Errorf("%w: 公开动态 tags 必须是字符串数组", ErrDraftInvalid)
		}
	}
	cleanedTags, err := cleanList(tags, MaxTags, MaxTagRunes, "tags")
	if err != nil {
		return nil, err
	}
	var revision int64
	if len(raw["revision"]) > 0 && string(raw["revision"]) != "null" {
		if err := json.Unmarshal(raw["revision"], &revision); err != nil || revision < 0 {
			return nil, fmt.Errorf("%w: 公开动态 revision 无效", ErrDraftInvalid)
		}
	}
	out := &sourcePost{
		path: rel, raw: raw, schemaVersion: schema,
		title: title, body: body, tags: cleanedTags, publishedAt: publishedAt,
		updatedAt: updatedAt, revision: revision, authorKind: kind,
		author: postAuthorJSON{PeerID: peerID, Kind: kind, DisplayName: displayName},
	}
	if schema == 2 {
		id, err := decodeOptionalString(raw["id"], "id")
		if err != nil {
			return nil, err
		}
		if id == "" || !sourcePostID.MatchString(id) {
			return nil, fmt.Errorf("%w: 公开动态 id 无效", ErrDraftInvalid)
		}
		out.id = id
		if len(raw["images"]) > 0 && string(raw["images"]) != "null" {
			if err := json.Unmarshal(raw["images"], &out.images); err != nil {
				return nil, fmt.Errorf("%w: 公开动态 images 必须是数组", ErrDraftInvalid)
			}
		}
		if len(out.images) > storage.MaxDraftImageCount {
			return nil, fmt.Errorf("%w: 公开动态最多 %d 张图片", ErrDraftInvalid, storage.MaxDraftImageCount)
		}
		for _, image := range out.images {
			if !strings.HasPrefix(image.Path, "images/") || strings.Contains(image.Path, "..") || strings.Contains(image.Path, "\\") {
				return nil, fmt.Errorf("%w: 公开动态图片路径无效", ErrDraftInvalid)
			}
			extension := ""
			switch image.Mime {
			case "image/png":
				extension = ".png"
			case "image/jpeg":
				extension = ".jpg"
			default:
				return nil, fmt.Errorf("%w: 公开动态图片格式不受支持", ErrDraftInvalid)
			}
			if image.Path != "images/"+image.SHA256+extension || len(image.SHA256) != 64 {
				return nil, fmt.Errorf("%w: 公开动态图片哈希与路径不一致", ErrDraftInvalid)
			}
			if image.Width <= 0 || image.Height <= 0 || image.SizeBytes <= 0 || image.SizeBytes > 8<<20 {
				return nil, fmt.Errorf("%w: 公开动态图片尺寸或大小无效", ErrDraftInvalid)
			}
		}
	}
	return out, nil
}

func rawString(value string) json.RawMessage {
	raw, _ := json.Marshal(value)
	return raw
}

func rawInt(value int64) json.RawMessage {
	raw, _ := json.Marshal(value)
	return raw
}

func rawStrings(values []string) json.RawMessage {
	if values == nil {
		values = []string{}
	}
	raw, _ := json.Marshal(values)
	return raw
}

func rawObject[T any](value T) json.RawMessage {
	raw, _ := json.Marshal(value)
	return raw
}

func plainPostSummary(body string) string {
	text := strings.NewReplacer("#", " ", "*", " ", "_", " ", "`", " ", ">", " ", "[", " ", "]", " ", "(", " ", ")", " ").Replace(body)
	text = strings.Join(strings.Fields(text), " ")
	runes := []rune(text)
	if len(runes) > 180 {
		return string(runes[:180])
	}
	return text
}
