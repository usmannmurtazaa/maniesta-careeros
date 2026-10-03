import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import {
  FiDownload,
  FiMaximize,
  FiMinimize,
  FiLoader,
  FiZoomIn,
  FiZoomOut,
  FiRotateCcw,
  FiAlertCircle,
  FiCheck,
  FiPrinter,
  FiShare2,
} from 'react-icons/fi';
import { motion, AnimatePresence } from 'framer-motion';
import Button from '../ui/Button';
import toast from 'react-hot-toast';
import { getResumeTemplateLoader } from './templates/resolveTemplate';

// ── Constants ─────────────────────────────────────────────────────────────

const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;
const CONTROLS_HIDE_DELAY = 3000;

// ── Utility Functions ────────────────────────────────────────────────────

const downloadResumeAsPDF = async (data, template) => {
  try {
    const { downloadResumeAsPDF: externalDownload } = await import('../../utils/pdfGenerator');
    return externalDownload(data, template);
  } catch {
    return new Promise((resolve, reject) => {
      try {
        window.print();
        resolve();
      } catch (err) {
        reject(new Error('PDF generation failed'));
      }
    });
  }
};

const getFullscreenElement = () => {
  return (
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement
  );
};

// ── Main Component ─────────────────────────────────────────────────────────

const ResumePreview = ({ data, template }) => {
  const previewRef = useRef(null);
  const containerRef = useRef(null);
  const controlsTimeoutRef = useRef(null);
  const lazyTemplateCacheRef = useRef({});

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [renderError, setRenderError] = useState(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [showControls, setShowControls] = useState(true);

  const isEmpty = !data || Object.keys(data).length === 0;

  // ── Lazy Template Cache ──────────────────────────────────────────────

  const getOrCreateLazyTemplate = useCallback((templateId) => {
    if (!lazyTemplateCacheRef.current[templateId]) {
      lazyTemplateCacheRef.current[templateId] = React.lazy(getResumeTemplateLoader(templateId));
    }
    return lazyTemplateCacheRef.current[templateId];
  }, []);

  // ── Fullscreen Monitoring ─────────────────────────────────────────────

  useEffect(() => {
    const handleChange = () => setIsFullscreen(!!getFullscreenElement());
    document.addEventListener('fullscreenchange', handleChange);
    document.addEventListener('webkitfullscreenchange', handleChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleChange);
      document.removeEventListener('webkitfullscreenchange', handleChange);
    };
  }, []);

  // ── Auto-hide Controls in Fullscreen ─────────────────────────────────

  useEffect(() => {
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);

    if (isFullscreen) {
      controlsTimeoutRef.current = setTimeout(() => setShowControls(false), CONTROLS_HIDE_DELAY);
    } else {
      setShowControls(true);
    }

    return () => {
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    };
  }, [isFullscreen]);

  // ── Mouse Activity ───────────────────────────────────────────────────

  const handleMouseMove = useCallback(() => {
    if (!isFullscreen) return;
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => setShowControls(false), CONTROLS_HIDE_DELAY);
  }, [isFullscreen]);

  // ── Template Loading ─────────────────────────────────────────────────
  //
  // This effect deliberately depends ONLY on `template`. Data changes must
  // NOT reset the loader or remount the template — that caused the preview
  // to flicker (loader → blank → fade-in → repeat) on every keystroke,
  // because the parent (`ResumeBuilder`) passes a new `data` object
  // reference on every render (react-hook-form's `watch()` returns a
  // fresh object each time it is called).
  //
  // Correct behavior:
  //   • First mount → brief loader while the lazy template chunk loads.
  //   • Template changes → brief loader while the new lazy chunk loads.
  //   • Data changes (typing, autosave, section navigation) → template
  //     re-renders in place with new props. No loader, no remount.

  useEffect(() => {
    setIsLoaded(false);
    setRenderError(null);
    const timer = setTimeout(() => setIsLoaded(true), 100);
    return () => clearTimeout(timer);
  }, [template]);

  // ── Handlers ─────────────────────────────────────────────────────────

  const handleDownload = useCallback(async () => {
    if (isEmpty) {
      toast.error('No content to download');
      return;
    }
    setIsDownloading(true);
    try {
      const loadingToast = toast.loading('Generating PDF...');
      await downloadResumeAsPDF(data, template);
      toast.dismiss(loadingToast);
      toast.success('Resume downloaded!', { icon: '📄' });
    } catch (error) {
      console.error('Download failed:', error);
      toast.error(error.message || 'Failed to download');
    } finally {
      setIsDownloading(false);
    }
  }, [isEmpty, data, template]);

  const handlePrint = useCallback(() => {
    if (isEmpty) {
      toast.error('No content to print');
      return;
    }
    const content = previewRef.current?.innerHTML;
    if (!content) {
      toast.error('Preview not ready');
      return;
    }

    const printWindow = window.open('', '_blank', 'width=900,height=700');
    if (!printWindow) {
      toast.error('Please allow popups');
      return;
    }

    printWindow.document.write(`
      <!DOCTYPE html><html><head><title>Resume</title>
      <style>body{padding:40px;font-family:Arial,sans-serif;color:#333;}@media print{body{padding:0;}}</style>
      </head><body><div style="text-align:right;margin-bottom:20px;">
      <button onclick="window.print()" style="padding:10px 20px;background:#3b82f6;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;">Print</button>
      </div>${content}</body></html>`);
    printWindow.document.close();
  }, [isEmpty]);

  const handleFullscreen = useCallback(async () => {
    if (!previewRef.current) return;
    try {
      if (!getFullscreenElement()) {
        await previewRef.current.requestFullscreen();
        toast.success('Press ESC to exit', { duration: 2000 });
      } else {
        await document.exitFullscreen();
      }
    } catch {
      toast.error('Fullscreen not supported');
    }
  }, []);

  const handleZoomIn = useCallback(
    () => setZoomLevel((p) => Math.min(p + ZOOM_STEP, ZOOM_MAX)),
    []
  );
  const handleZoomOut = useCallback(
    () => setZoomLevel((p) => Math.max(p - ZOOM_STEP, ZOOM_MIN)),
    []
  );
  const handleZoomReset = useCallback(() => setZoomLevel(100), []);

  const handleShare = useCallback(async () => {
    if (isEmpty) {
      toast.error('No content to share');
      return;
    }
    try {
      if (navigator.share) {
        await navigator.share({ title: 'My Resume', url: window.location.href });
      } else {
        await navigator.clipboard.writeText(window.location.href);
        toast.success('Link copied!');
      }
    } catch (error) {
      if (error.name !== 'AbortError') toast.error('Failed to share');
    }
  }, [isEmpty]);

  const handleRetry = useCallback(() => {
    setRenderError(null);
  }, []);

  // ── Keyboard Shortcuts ───────────────────────────────────────────────

  useEffect(() => {
    const handler = (e) => {
      if (
        e.target.tagName === 'INPUT' ||
        e.target.tagName === 'TEXTAREA' ||
        e.target.isContentEditable
      )
        return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        handleDownload();
      }
      if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        handleFullscreen();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        handleZoomReset();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '=') {
        e.preventDefault();
        handleZoomIn();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        handleZoomOut();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleDownload, handleFullscreen, handleZoomIn, handleZoomOut, handleZoomReset]);

  // ── Render Template ──────────────────────────────────────────────────
  //
  // `key={template}` (not a state counter). The template remounts only when
  // the user picks a different template, which is the only case where a
  // full remount is desired. Data changes flow through as props.

  const renderTemplate = useCallback(() => {
    if (isEmpty) {
      return (
        <div className="flex min-h-[300px] flex-col items-center justify-center p-8 text-center">
          <FiAlertCircle className="mb-4 h-12 w-12 text-gray-300" />
          <h3 className="mb-2 text-lg font-semibold text-gray-700 dark:text-gray-300">
            No Content Yet
          </h3>
          <p className="max-w-md text-sm text-gray-500">
            Start adding your information to see a preview.
          </p>
        </div>
      );
    }

    try {
      const TemplateComponent = getOrCreateLazyTemplate(template);

      return (
        <React.Suspense
          fallback={
            <div className="p-8 text-center">
              <FiLoader className="mx-auto h-8 w-8 animate-spin" />
            </div>
          }
        >
          <TemplateComponent key={template} data={data} />
        </React.Suspense>
      );
    } catch (error) {
      console.error('Template error:', error);
      setRenderError(error);
      return null;
    }
  }, [isEmpty, template, data, getOrCreateLazyTemplate]);

  // ── Zoom Controls Component ──────────────────────────────────────────

  const ZoomControls = useMemo(
    () => (
      <div className="flex items-center gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-800">
        <button
          onClick={handleZoomOut}
          disabled={zoomLevel <= ZOOM_MIN}
          className="rounded p-1.5 hover:bg-gray-200 disabled:opacity-50 dark:hover:bg-gray-700"
          aria-label="Zoom out"
        >
          <FiZoomOut className="h-4 w-4" />
        </button>
        <span className="min-w-[3rem] text-center text-xs font-medium">{zoomLevel}%</span>
        <button
          onClick={handleZoomIn}
          disabled={zoomLevel >= ZOOM_MAX}
          className="rounded p-1.5 hover:bg-gray-200 disabled:opacity-50 dark:hover:bg-gray-700"
          aria-label="Zoom in"
        >
          <FiZoomIn className="h-4 w-4" />
        </button>
        <button
          onClick={handleZoomReset}
          className="ml-1 rounded p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700"
          aria-label="Reset zoom"
        >
          <FiRotateCcw className="h-4 w-4" />
        </button>
      </div>
    ),
    [zoomLevel, handleZoomIn, handleZoomOut, handleZoomReset]
  );

  return (
    <div
      className="space-y-3 sm:space-y-4"
      onMouseMove={handleMouseMove}
      onTouchStart={handleMouseMove}
    >
      {/* Controls */}
      <AnimatePresence>
        {showControls && (
          <motion.div
            className="flex flex-col gap-2 sm:flex-row sm:gap-3"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
          >
            <div className="flex flex-1 gap-2">
              <Button
                variant="outline"
                onClick={handleFullscreen}
                icon={isFullscreen ? <FiMinimize /> : <FiMaximize />}
                size="sm"
                className="flex-1 sm:flex-none"
              >
                {isFullscreen ? 'Exit' : 'Full'}
              </Button>
              <Button
                onClick={handleDownload}
                loading={isDownloading}
                disabled={isEmpty}
                icon={<FiDownload />}
                size="sm"
                className="flex-1 sm:flex-none"
              >
                {isDownloading ? '...' : 'PDF'}
              </Button>
              <div className="hidden gap-2 sm:flex">
                <Button
                  variant="outline"
                  onClick={handlePrint}
                  disabled={isEmpty}
                  icon={<FiPrinter />}
                  size="sm"
                >
                  Print
                </Button>
                <Button
                  variant="outline"
                  onClick={handleShare}
                  disabled={isEmpty}
                  icon={<FiShare2 />}
                  size="sm"
                >
                  Share
                </Button>
              </div>
            </div>
            <div className="hidden sm:flex">{ZoomControls}</div>
            {!isEmpty && !renderError && isLoaded && (
              <div className="hidden items-center gap-1 px-2 text-xs text-green-500 lg:flex">
                <FiCheck className="h-3 w-3" />
                Ready
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Preview */}
      <div
        ref={containerRef}
        className={`relative overflow-hidden rounded-lg bg-white shadow-2xl transition-all dark:bg-gray-900 ${
          isFullscreen ? 'fixed inset-0 z-50 rounded-none' : ''
        }`}
        style={{
          transform: !isFullscreen ? `scale(${zoomLevel / 100})` : 'none',
          transformOrigin: 'top center',
        }}
      >
        {!isLoaded && !isEmpty && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white dark:bg-gray-900">
            <FiLoader className="h-8 w-8 animate-spin text-primary-500" />
          </div>
        )}

        <div
          ref={previewRef}
          className={
            isFullscreen ? 'h-screen overflow-auto bg-gray-50 p-4 sm:p-8 dark:bg-gray-950' : ''
          }
          style={{ maxHeight: isFullscreen ? '100vh' : 'calc(100vh - 200px)', overflowY: 'auto' }}
        >
          <div className={isFullscreen ? 'mx-auto my-8 max-w-5xl shadow-2xl' : ''}>
            {renderError ? (
              <div className="p-8 text-center">
                <FiAlertCircle className="mx-auto mb-3 h-12 w-12 text-red-500" />
                <h3 className="mb-2 text-lg font-semibold">Preview Error</h3>
                <p className="mb-4 text-sm text-gray-500">Failed to render template.</p>
                <Button variant="outline" size="sm" onClick={handleRetry}>
                  Try Again
                </Button>
              </div>
            ) : (
              renderTemplate()
            )}
          </div>
        </div>
      </div>

      {/* Mobile Controls */}
      <div className="mt-2 flex items-center justify-center gap-2 sm:hidden">
        {ZoomControls}
        <button
          onClick={handlePrint}
          disabled={isEmpty}
          className="rounded-lg bg-gray-100 p-2 disabled:opacity-50 dark:bg-gray-800"
          aria-label="Print"
        >
          <FiPrinter className="h-4 w-4" />
        </button>
        <button
          onClick={handleShare}
          disabled={isEmpty}
          className="rounded-lg bg-gray-100 p-2 disabled:opacity-50 dark:bg-gray-800"
          aria-label="Share"
        >
          <FiShare2 className="h-4 w-4" />
        </button>
      </div>

      {/* Fullscreen Hints */}
      <AnimatePresence>
        {isFullscreen && showControls && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed right-4 top-4 z-50 hidden rounded-lg bg-white/90 px-3 py-1.5 text-xs text-gray-500 shadow-lg backdrop-blur-sm dark:bg-gray-800/90 lg:block"
          >
            F: Fullscreen • ⌘P: Download • ⌘0: Reset • ESC: Exit
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// ── Memo Comparator ────────────────────────────────────────────────────────
//
// Reference equality on `data` never short-circuits: the parent
// (`ResumeBuilder`) calls `watch()` on every render and gets a fresh object
// each time. Comparing `JSON.stringify` of the payload is the correct
// shallow-content check for a resume-shaped object; it is cheap relative to
// the cost of re-rendering a template tree and skipping it whenever the
// parent re-renders for unrelated reasons (section navigation, sidebar
// collapse, toast appearance, etc.).
//
// If `JSON.stringify` throws — circular reference, or a field the caller
// forgot to serialize — fall through to re-rendering. Safer than crashing
// inside the comparator.

export default React.memo(ResumePreview, (prev, next) => {
  if (prev.template !== next.template) return false;
  try {
    return JSON.stringify(prev.data) === JSON.stringify(next.data);
  } catch {
    return false;
  }
});