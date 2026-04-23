import { Check, Copy, KeyRound, Terminal } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * Convert an ArrayBuffer to a base64 string. Used to wrap WebCrypto
 * exports (PKCS#8 for the private key, SPKI for the public key) into
 * PEM-armored blocks.
 */
function bufToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

function wrapPem(base64: string, header: string): string {
  // Standard PEM: 64 chars per line between BEGIN/END markers.
  const wrapped = base64.match(/.{1,64}/g)?.join('\n') ?? base64;
  return `-----BEGIN ${header}-----\n${wrapped}\n-----END ${header}-----`;
}

/**
 * Generate an RSA 2048-bit keypair in the browser via WebCrypto.
 * - `algorithm: RSASSA-PKCS1-v1_5` + `hash: SHA-1` matches Tiger Open
 *   API's server-side verification (`sign_type=RSA` in their SDK).
 * - Exports: PKCS#8 PEM private key, SPKI PEM public key — both are the
 *   formats Tiger's web portal accepts.
 */
async function generateRsaKeypair(): Promise<{ privatePem: string; publicPem: string }> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: { name: 'SHA-1' },
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;

  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);

  return {
    privatePem: wrapPem(bufToBase64(pkcs8), 'PRIVATE KEY'),
    publicPem: wrapPem(bufToBase64(spki), 'PUBLIC KEY'),
  };
}

interface RsaKeypairFieldProps {
  privateKey: string;
  onPrivateKeyChange: (next: string) => void;
  disabled?: boolean;
}

/**
 * Composite input for providers that require the user to upload a
 * public key to the broker's portal and keep the matching private key
 * locally (Tiger Brokers is the main case). Offers an in-browser
 * keypair generator as convenience, plus a clear explanation of why
 * doing it yourself via `openssl` is the safer path.
 */
export function RsaKeypairField({
  privateKey,
  onPrivateKeyChange,
  disabled,
}: RsaKeypairFieldProps) {
  const [publicKey, setPublicKey] = useState('');
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const { privatePem, publicPem } = await generateRsaKeypair();
      onPrivateKeyChange(privatePem);
      setPublicKey(publicPem);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate keypair');
    } finally {
      setGenerating(false);
    }
  };

  const handleCopyPublic = async () => {
    if (!publicKey) return;
    try {
      await navigator.clipboard.writeText(publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (http context, Safari private mode, etc.).
      // User can still select-all the textarea manually.
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="rsa-private-key">Private Key (PEM)</Label>
        <Textarea
          id="rsa-private-key"
          value={privateKey}
          onChange={(e) => onPrivateKeyChange(e.target.value)}
          placeholder={
            'Paste your RSA private key here (PEM-encoded, including the BEGIN/END header lines), or click "Generate keypair in browser" below.'
          }
          className="font-mono text-xs h-36"
          disabled={disabled}
        />
      </div>

      <div className="flex items-start gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleGenerate}
          disabled={disabled || generating}
        >
          <KeyRound className="h-3.5 w-3.5 mr-1.5" />
          {generating ? 'Generating…' : 'Generate keypair in browser'}
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {publicKey && (
        <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="rsa-public-key" className="text-xs font-medium">
              Public Key — paste this into Tiger's portal
            </Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleCopyPublic}
              className="h-7 text-xs"
            >
              {copied ? (
                <>
                  <Check className="h-3 w-3 mr-1" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3 mr-1" />
                  Copy
                </>
              )}
            </Button>
          </div>
          <Textarea
            id="rsa-public-key"
            value={publicKey}
            readOnly
            className="font-mono text-xs h-28 bg-background"
          />
          <p className="text-xs text-muted-foreground">
            Upload this public key to your Tiger Open Platform application. The matching private key
            is already filled in above — it stays encrypted end-to-end and is never shown to Tiger.
          </p>
        </div>
      )}

      <details className="rounded-md border border-muted bg-muted/30 p-3 text-xs">
        <summary className="flex cursor-pointer items-center gap-1.5 font-medium text-muted-foreground">
          <Terminal className="h-3 w-3" />
          Prefer to generate the key yourself? (recommended)
        </summary>
        <div className="mt-2 space-y-2 text-muted-foreground">
          <p>
            In-browser generation is convenient, but you're trusting this page (and its JS) with a
            fresh private key. Running the keypair generation yourself on a machine you control is
            more auditable — no chance of an injected or backdoored{' '}
            <code className="text-[10px]">crypto.subtle</code> implementation.
          </p>
          <p>Two commands produce exactly the same format:</p>
          <pre className="overflow-x-auto rounded bg-background p-2 text-[11px] font-mono">
            {`# Generate a 2048-bit RSA private key (PKCS#8 PEM)
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out tiger.key

# Derive the matching public key (SPKI PEM) to paste into Tiger's portal
openssl rsa -in tiger.key -pubout -out tiger.pub

# Show the files — paste tiger.key below, tiger.pub into Tiger's portal
cat tiger.pub
cat tiger.key`}
          </pre>
          <p>
            Paste the contents of <code>tiger.key</code> into the field above. The public key (
            <code>tiger.pub</code>) goes into your Tiger application settings.
          </p>
        </div>
      </details>
    </div>
  );
}
