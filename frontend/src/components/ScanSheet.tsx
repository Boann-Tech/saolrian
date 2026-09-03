import { useEffect, useRef, useState } from 'react';
import { Field } from './ui';
import './scansheet.css';

/**
 * Barcode scan sheet — camera-first when the browser supports it
 * (BarcodeDetector + getUserMedia), always falling back to manual
 * numeric entry. Emits a resolved code via onCode.
 */
interface ScanSheetProps {
  open: boolean;
  onClose: () => void;
  onCode: (code: string) => void;
}

type CamState = 'idle' | 'starting' | 'on' | 'denied' | 'unsupported';

interface DetectorLike {
  detect(image: CanvasImageSource): Promise<{ rawValue: string }[]>; 
}

export default function ScanSheet({ open, onClose, onCode }: ScanSheetProps) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [cam, setCam] = useState<CamState>('idle');
  const [camErr, setCamErr] = useState('');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | undefined>(undefined);
  const detRef = useRef<DetectorLike | null>(null);
  const loopRef = useRef<boolean>(false);

  const stopCam = () => {
    loopRef.current = false;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = undefined;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  useEffect(() => {
    if (!open) {
      stopCam();
      setCam('idle');
      setCamErr('');
      setErr('');
      return;
    }
    setCode('');
    const w = window as unknown as { BarcodeDetector?: new (o?: { formats?: string[] }) => DetectorLike };
    if (typeof w.BarcodeDetector === 'undefined') {
      setCam('unsupported');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCam('unsupported');
      return;
    }
    try {
      detRef.current = new w.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
    } catch {
      setCam('unsupported');
      return;
    }
    let cancelled = false;
    setCam('starting');
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
        setCam('on');
        loopRef.current = true;
        const tick = async () => {
          if (!loopRef.current) return;
          const video = videoRef.current;
          const det = detRef.current;
          if (video && det && video.readyState >= 2) {
            try {
              const codes = await det.detect(video);
              if (codes.length > 0 && codes[0].rawValue) {
                const found = codes[0].rawValue.trim();
                stopCam();
                onCode(found);
                onClose();
                return;
              }
            } catch { /* transient — keep scanning */ }
          }
          rafRef.current = requestAnimationFrame(() => { void tick(); });
        };
        void tick();
      })
      .catch((ex: unknown) => {
        if (cancelled) return;
        setCam('denied');
        setCamErr(
          ex instanceof DOMException && ex.name === 'NotAllowedError'
            ? 'Camera permission blocked — allow camera access, or enter the code manually.'
            : 'Could not start the camera — enter the code manually.'
        );
      });
    return () => {
      cancelled = true;
      stopCam();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => () => { stopCam(); }, []);

  const submitManual = () => {
    const c = code.trim();
    if (!/^\d{6,}$/.test(c)) {
      setErr('Enter a numeric barcode (at least 6 digits).');
      return;
    }
    setErr('');
    onCode(c);
    onClose();
  };

  if (!open) return null;
  return (
    <div className="scan-scrim" onClick={onClose}>
      <div className="scan-sheet" role="dialog" aria-label="Scan barcode" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <h3>Scan a barcode</h3>
        <div className="sub">Point your camera at the barcode — it resolves automatically. No camera? Type the digits under the code below.</div>

        {cam === 'starting' && (
          <div className="scan-cam scan-status">
            <span className="spinner-sm" aria-hidden /> Starting camera…
          </div>
        )}

        {cam === 'on' && (
          <>
            <div className="scan-cam">
              <video ref={videoRef} playsInline muted aria-label="Camera preview" />
              <div className="scan-frame" />
            </div>
            <p className="scan-hint">Align the barcode inside the frame.</p>
          </>
        )}

        {(cam === 'unsupported' || cam === 'denied') && (
          <div className="scan-cam scan-fallback">
            {cam === 'unsupported'
              ? 'Camera scanning isn’t supported on this browser — the server-side food DB still works via manual codes.'
              : camErr}
          </div>
        )}

        <Field label="Or enter barcode manually">
          <input
            autoFocus
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="e.g. 3017620422003"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') submitManual(); }}
          />
        </Field>
        {err && <div className="scan-err">{err}</div>}
        <div className="scan-actions">
          <button className="btn outline" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={submitManual}>Look up</button>
        </div>
      </div>
    </div>
  );
}