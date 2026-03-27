import { memo, useState, useRef, useCallback, useEffect } from 'react';
import { Handle, Position, NodeResizeControl } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { Trash2, Plus, X, Image, Film, Link, Loader2 } from 'lucide-react';
import axios from 'axios';

const STICKY_COLORS = [
  '#FBBF24', // Yellow
  '#FB923C', // Orange
  '#F87171', // Red/Pink
  '#A78BFA', // Purple
  '#60A5FA', // Blue
  '#4ADE80', // Green
  '#38BDF8', // Light blue
  '#E879F9', // Magenta
];

const handleStyle = { background: '#3A3A3C', width: 8, height: 8, borderColor: '#1C1C1E', borderWidth: 2, opacity: 0 };

interface MediaItem {
  id: string;
  filename: string;
  media_type: 'image' | 'video';
  mime_type: string;
  url?: string;
}

function StickyNoteNode({ id, data, selected }: NodeProps) {
  const {
    content = '',
    color = '#FBBF24',
    noteWidth = 280,
    noteHeight = 200,
    media = [],
    caseId,
    onUpdate,
    onDelete,
    onMediaUpload,
    onMediaDelete,
  } = data;

  const [localWidth, setLocalWidth] = useState(noteWidth);
  const [localHeight, setLocalHeight] = useState(noteHeight);
  const isCompact = localWidth < 200 || localHeight < 150;

  const [editing, setEditing] = useState(false);
  const [localContent, setLocalContent] = useState(content);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [expandedMedia, setExpandedMedia] = useState<string | null>(null);
  const [linkInput, setLinkInput] = useState('');
  const [showLinkInput, setShowLinkInput] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync from props
  useEffect(() => {
    if (!editing) setLocalContent(content);
  }, [content, editing]);
  useEffect(() => { setLocalWidth(noteWidth); }, [noteWidth]);
  useEffect(() => { setLocalHeight(noteHeight); }, [noteHeight]);

  // Fetch signed URLs for media on mount
  useEffect(() => {
    if (!media.length || !caseId) return;
    media.forEach((m: MediaItem) => {
      if (mediaUrls[m.id]) return;
      axios.get(`/api/cases/${caseId}/graph/sticky-notes/${id}/media/${m.id}/url`)
        .then(res => setMediaUrls(prev => ({ ...prev, [m.id]: res.data.url })))
        .catch(() => {});
    });
  }, [media, caseId, id]);

  const debouncedSave = useCallback((newContent: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      onUpdate?.(id, { content: newContent });
    }, 1000);
  }, [id, onUpdate]);

  const handleContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setLocalContent(val);
    debouncedSave(val);
  }, [debouncedSave]);

  const handleBlur = useCallback(() => {
    setEditing(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    onUpdate?.(id, { content: localContent });
  }, [id, localContent, onUpdate]);

  const handleColorChange = useCallback((newColor: string) => {
    onUpdate?.(id, { color: newColor });
    setShowColorPicker(false);
  }, [id, onUpdate]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setShowAddMenu(false);
    try {
      await onMediaUpload?.(id, file);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [id, onMediaUpload]);

  const handleAddLink = useCallback(() => {
    if (!linkInput.trim()) return;
    let url = linkInput.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    // Append link to content
    const linkText = `\n[${url}]`;
    const newContent = localContent + linkText;
    setLocalContent(newContent);
    onUpdate?.(id, { content: newContent });
    setLinkInput('');
    setShowLinkInput(false);
    setShowAddMenu(false);
  }, [id, linkInput, localContent, onUpdate]);

  const handleDeleteMedia = useCallback(async (mediaId: string) => {
    await onMediaDelete?.(id, mediaId);
    setMediaUrls(prev => {
      const next = { ...prev };
      delete next[mediaId];
      return next;
    });
  }, [id, onMediaDelete]);

  // Parse links from content
  const renderContent = (text: string) => {
    if (editing) return null;
    const urlRegex = /\[?(https?:\/\/[^\s\]]+)\]?/g;
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;
    let key = 0;

    while ((match = urlRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(<span key={key++}>{text.slice(lastIndex, match.index)}</span>);
      }
      const url = match[1];
      let display = url;
      try { display = new URL(url).hostname.replace('www.', ''); } catch {}
      parts.push(
        <a
          key={key++}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#5AC8FA] hover:underline break-all"
          onClick={e => e.stopPropagation()}
        >
          {display}
        </a>
      );
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      parts.push(<span key={key++}>{text.slice(lastIndex)}</span>);
    }
    return parts.length ? parts : text;
  };

  return (
    <div
      className="relative group"
      style={{
        width: '100%',
        height: '100%',
        minWidth: 80,
        minHeight: 60,
      }}
    >
      {/* Resize handle */}
      <NodeResizeControl
        minWidth={80}
        minHeight={60}
        style={{ background: 'transparent', border: 'none' }}
        onResizeEnd={(_: any, params: any) => {
          setLocalWidth(params.width);
          setLocalHeight(params.height);
          onUpdate?.(id, { width: params.width, height: params.height });
        }}
      >
        <svg
          width="12" height="12" viewBox="0 0 12 12"
          style={{ position: 'absolute', right: 4, bottom: 4, cursor: 'nwse-resize', opacity: 0.3 }}
        >
          <path d="M11 1L1 11M11 6L6 11" stroke="white" strokeWidth="1.5" />
        </svg>
      </NodeResizeControl>

      {/* Handles for edge connections */}
      <Handle type="target" position={Position.Top} id="t-top" style={handleStyle} />
      <Handle type="source" position={Position.Bottom} id="s-bottom" style={handleStyle} />
      <Handle type="target" position={Position.Left} id="t-left" style={handleStyle} />
      <Handle type="source" position={Position.Right} id="s-right" style={handleStyle} />

      {/* Note body */}
      <div
        style={{
          width: '100%',
          height: '100%',
          background: '#1C1C1E',
          border: `1.5px solid ${selected ? color : color + '50'}`,
          borderRadius: 12,
          boxShadow: selected
            ? `0 0 20px ${color}30, 0 4px 16px rgba(0,0,0,0.4)`
            : '0 4px 16px rgba(0,0,0,0.4)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column' as const,
          transition: 'border-color 0.2s, box-shadow 0.2s',
        }}
      >
        {/* Color accent bar + controls */}
        <div
          style={{
            height: 6,
            background: color,
            cursor: 'pointer',
            flexShrink: 0,
            position: 'relative' as const,
          }}
          onClick={(e) => { e.stopPropagation(); setShowColorPicker(!showColorPicker); }}
        />

        {/* Color picker dropdown */}
        {showColorPicker && (
          <div
            className="absolute z-50 top-8 left-2 flex gap-1 p-1.5 bg-[#2C2C2E] rounded-lg border border-[rgba(84,84,88,0.65)]"
            onClick={e => e.stopPropagation()}
          >
            {STICKY_COLORS.map(c => (
              <button
                key={c}
                onClick={() => handleColorChange(c)}
                className="w-5 h-5 rounded-full border-2 transition-transform hover:scale-110"
                style={{
                  background: c,
                  borderColor: c === color ? 'white' : 'transparent',
                }}
              />
            ))}
          </div>
        )}

        {/* Content area */}
        <div
          className="flex-1 overflow-y-auto p-3 nowheel"
          style={{ cursor: 'text' }}
          onClick={() => { if (!editing) setEditing(true); }}
        >
          {editing ? (
            <textarea
              ref={textareaRef}
              value={localContent}
              onChange={handleContentChange}
              onBlur={handleBlur}
              autoFocus
              placeholder="Write a note..."
              className="w-full h-full bg-transparent text-[13px] text-[rgba(235,235,245,0.85)] resize-none outline-none placeholder-[rgba(235,235,245,0.2)] leading-relaxed nowheel nodrag"
              onKeyDown={e => e.stopPropagation()}
            />
          ) : (
            <div className="text-[13px] text-[rgba(235,235,245,0.85)] whitespace-pre-wrap leading-relaxed min-h-[20px]">
              {localContent ? renderContent(localContent) : (
                <span className="text-[rgba(235,235,245,0.2)] italic">Click to write a note...</span>
              )}
            </div>
          )}
        </div>

        {/* Media thumbnails — collapse to badge when note is small */}
        {media.length > 0 && (
          isCompact ? (
            <div className="flex items-center justify-center pb-1.5 nodrag">
              <button
                className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.4)] cursor-pointer hover:border-[rgba(84,84,88,0.8)] transition-colors"
                onClick={(e) => { e.stopPropagation(); setExpandedMedia(media[0].id); }}
              >
                <Image size={10} className="text-[rgba(235,235,245,0.5)]" />
                <span className="text-[9px] text-[rgba(235,235,245,0.5)]">{media.length}</span>
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5 px-3 pb-2 nodrag">
              {media.map((m: MediaItem) => (
                <div key={m.id} className="relative group/media">
                  {m.media_type === 'image' ? (
                    <img
                      src={mediaUrls[m.id] || ''}
                      alt={m.filename}
                      className="w-16 h-16 object-cover rounded-lg cursor-pointer border border-[rgba(84,84,88,0.4)] hover:border-[rgba(84,84,88,0.8)] transition-colors"
                      onClick={(e) => { e.stopPropagation(); setExpandedMedia(expandedMedia === m.id ? null : m.id); }}
                      loading="lazy"
                    />
                  ) : (
                    <div
                      className="w-16 h-16 rounded-lg bg-[#2C2C2E] flex items-center justify-center cursor-pointer border border-[rgba(84,84,88,0.4)] hover:border-[rgba(84,84,88,0.8)] transition-colors"
                      onClick={(e) => { e.stopPropagation(); setExpandedMedia(expandedMedia === m.id ? null : m.id); }}
                    >
                      <Film size={20} className="text-[rgba(235,235,245,0.4)]" />
                    </div>
                  )}
                  <button
                    className="absolute -top-1 -right-1 w-4 h-4 bg-[#FF453A] rounded-full items-center justify-center hidden group-hover/media:flex"
                    onClick={(e) => { e.stopPropagation(); handleDeleteMedia(m.id); }}
                  >
                    <X size={10} className="text-white" />
                  </button>
                </div>
              ))}
            </div>
          )
        )}

        {/* Expanded media view */}
        {expandedMedia && (
          <div
            className="absolute inset-0 z-40 bg-black/80 flex items-center justify-center rounded-xl nodrag"
            onClick={(e) => { e.stopPropagation(); setExpandedMedia(null); }}
          >
            {media.find((m: MediaItem) => m.id === expandedMedia)?.media_type === 'image' ? (
              <img
                src={mediaUrls[expandedMedia] || ''}
                className="max-w-full max-h-full object-contain rounded-lg"
              />
            ) : (
              <video
                src={mediaUrls[expandedMedia] || ''}
                controls
                className="max-w-full max-h-full rounded-lg"
                onClick={e => e.stopPropagation()}
              />
            )}
            <button
              className="absolute top-2 right-2 w-6 h-6 bg-[#2C2C2E] rounded-full flex items-center justify-center"
              onClick={(e) => { e.stopPropagation(); setExpandedMedia(null); }}
            >
              <X size={14} className="text-white" />
            </button>
          </div>
        )}

        {/* Bottom toolbar — hidden when compact */}
        {!isCompact && <div
          className="flex items-center justify-between px-2 py-1.5 border-t border-[rgba(84,84,88,0.2)] nodrag"
          style={{ flexShrink: 0 }}
        >
          <div className="flex items-center gap-1">
            {/* Add button */}
            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); setShowAddMenu(!showAddMenu); }}
                className="p-1 rounded hover:bg-[rgba(255,255,255,0.08)] transition-colors"
                title="Add media or link"
              >
                {uploading ? (
                  <Loader2 size={14} className="text-[rgba(235,235,245,0.4)] animate-spin" />
                ) : (
                  <Plus size={14} className="text-[rgba(235,235,245,0.4)]" />
                )}
              </button>

              {/* Add menu dropdown */}
              {showAddMenu && (
                <div
                  className="absolute bottom-full left-0 mb-1 bg-[#2C2C2E] rounded-lg border border-[rgba(84,84,88,0.65)] overflow-hidden z-50 min-w-[140px]"
                  onClick={e => e.stopPropagation()}
                >
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-[rgba(235,235,245,0.6)] hover:bg-[rgba(255,255,255,0.08)] transition-colors"
                  >
                    <Image size={13} /> Photo
                  </button>
                  <button
                    onClick={() => {
                      if (fileInputRef.current) {
                        fileInputRef.current.accept = 'video/*';
                        fileInputRef.current.click();
                        // Reset accept after click
                        setTimeout(() => { if (fileInputRef.current) fileInputRef.current.accept = 'image/*,video/*'; }, 100);
                      }
                    }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-[rgba(235,235,245,0.6)] hover:bg-[rgba(255,255,255,0.08)] transition-colors"
                  >
                    <Film size={13} /> Video
                  </button>
                  <div className="border-t border-[rgba(84,84,88,0.3)]" />
                  <button
                    onClick={() => { setShowLinkInput(true); setShowAddMenu(false); }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-[rgba(235,235,245,0.6)] hover:bg-[rgba(255,255,255,0.08)] transition-colors"
                  >
                    <Link size={13} /> Link
                  </button>
                </div>
              )}
            </div>

            {/* Link input */}
            {showLinkInput && (
              <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                <input
                  type="text"
                  value={linkInput}
                  onChange={e => setLinkInput(e.target.value)}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') handleAddLink(); if (e.key === 'Escape') setShowLinkInput(false); }}
                  placeholder="https://..."
                  autoFocus
                  className="w-[120px] px-1.5 py-0.5 text-[11px] bg-[#2C2C2E] text-[rgba(235,235,245,0.6)] rounded border border-[rgba(84,84,88,0.65)] outline-none"
                />
                <button
                  onClick={handleAddLink}
                  className="text-[11px] text-[#5AC8FA] hover:underline"
                >
                  Add
                </button>
              </div>
            )}
          </div>

          {/* Delete button */}
          <button
            onClick={(e) => { e.stopPropagation(); onDelete?.(id); }}
            className="p-1 rounded hover:bg-[rgba(255,59,48,0.15)] transition-colors opacity-0 group-hover:opacity-100"
            title="Delete note"
          >
            <Trash2 size={13} className="text-[#FF453A]" />
          </button>
        </div>}
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        className="hidden"
        onChange={handleFileUpload}
      />
    </div>
  );
}

export default memo(StickyNoteNode);
