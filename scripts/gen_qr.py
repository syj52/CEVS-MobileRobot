"""Generate QR code from URL argument, output PNG to stdout."""
import qrcode, sys, io
url = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8000/nav'
qr = qrcode.make(url)
buf = io.BytesIO()
qr.save(buf, 'PNG')
sys.stdout.buffer.write(buf.getvalue())
