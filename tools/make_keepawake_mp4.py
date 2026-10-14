"""Write assets/keepawake.mp4: a tiny black video with a silent sound track, written from scratch.

    python tools/make_keepawake_mp4.py

Why: when the Screen Wake Lock API is not available, Safari keeps the screen on while a video
plays that has both picture and sound, is not muted and is not set to loop. This file is
4 seconds of 64x64 black picture (H.264 Baseline, uncompressed I_PCM macroblocks, so no
encoder is needed) and silent AAC-LC mono audio (each frame is the 4-byte "no spectral data"
element), in a standard MP4 container.
"""
import os
import struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'keepawake.mp4')

W, H = 64, 64
FRAMES = 4                 # one frame a second
VIDEO_TS = 1000            # video timescale (ms)
SR = 44100                 # audio sample rate
AAC_FRAMES = (FRAMES * SR + 1023) // 1024
SILENT_AAC = bytes([0x01, 0x40, 0x20, 0x07])   # SCE, global_gain 160, max_sfb 0, END
ASC = bytes([0x12, 0x08])                      # AudioSpecificConfig: AAC-LC, 44.1 kHz, mono


# ---------------------------------------------------------------- H.264 bitstream

class Bits:
    def __init__(self):
        self.bits = []

    def u(self, n, v):
        for i in range(n - 1, -1, -1):
            self.bits.append((v >> i) & 1)

    def ue(self, v):
        v += 1
        n = v.bit_length()
        self.u(n - 1, 0)
        self.u(n, v)

    def se(self, v):
        self.ue(2 * v - 1 if v > 0 else -2 * v)

    def align_zero(self):
        while len(self.bits) % 8:
            self.bits.append(0)

    def trailing(self):
        self.bits.append(1)
        self.align_zero()

    def bytes(self):
        assert len(self.bits) % 8 == 0
        out = bytearray()
        for i in range(0, len(self.bits), 8):
            b = 0
            for bit in self.bits[i:i + 8]:
                b = (b << 1) | bit
            out.append(b)
        return bytes(out)


def ebsp(rbsp):
    """Insert emulation-prevention bytes (00 00 0x -> 00 00 03 0x for x <= 3)."""
    out = bytearray()
    zeros = 0
    for b in rbsp:
        if zeros >= 2 and b <= 3:
            out.append(3)
            zeros = 0
        out.append(b)
        zeros = zeros + 1 if b == 0 else 0
    return bytes(out)


def nal(header, rbsp):
    return bytes([header]) + ebsp(rbsp)


def sps():
    b = Bits()
    b.u(8, 66)        # profile_idc: Baseline
    b.u(8, 0xC0)      # constraint_set0 and set1 (constrained baseline)
    b.u(8, 30)        # level_idc 3.0
    b.ue(0)           # seq_parameter_set_id
    b.ue(0)           # log2_max_frame_num_minus4
    b.ue(2)           # pic_order_cnt_type
    b.ue(1)           # max_num_ref_frames
    b.u(1, 0)         # gaps_in_frame_num_value_allowed_flag
    b.ue(W // 16 - 1)
    b.ue(H // 16 - 1)
    b.u(1, 1)         # frame_mbs_only_flag
    b.u(1, 1)         # direct_8x8_inference_flag
    b.u(1, 0)         # frame_cropping_flag
    b.u(1, 0)         # vui_parameters_present_flag
    b.trailing()
    return nal(0x67, b.bytes())


def pps():
    b = Bits()
    b.ue(0)           # pic_parameter_set_id
    b.ue(0)           # seq_parameter_set_id
    b.u(1, 0)         # entropy_coding_mode_flag (CAVLC)
    b.u(1, 0)         # bottom_field_pic_order_in_frame_present_flag
    b.ue(0)           # num_slice_groups_minus1
    b.ue(0)           # num_ref_idx_l0_default_active_minus1
    b.ue(0)           # num_ref_idx_l1_default_active_minus1
    b.u(1, 0)         # weighted_pred_flag
    b.u(2, 0)         # weighted_bipred_idc
    b.se(0)           # pic_init_qp_minus26
    b.se(0)           # pic_init_qs_minus26
    b.se(0)           # chroma_qp_index_offset
    b.u(1, 1)         # deblocking_filter_control_present_flag
    b.u(1, 0)         # constrained_intra_pred_flag
    b.u(1, 0)         # redundant_pic_cnt_present_flag
    b.trailing()
    return nal(0x68, b.bytes())


def idr_slice(idr_pic_id):
    b = Bits()
    b.ue(0)           # first_mb_in_slice
    b.ue(7)           # slice_type: I (all slices)
    b.ue(0)           # pic_parameter_set_id
    b.u(4, 0)         # frame_num
    b.ue(idr_pic_id)  # idr_pic_id
    b.u(1, 0)         # no_output_of_prior_pics_flag
    b.u(1, 0)         # long_term_reference_flag
    b.se(0)           # slice_qp_delta
    b.ue(1)           # disable_deblocking_filter_idc: off
    for _ in range((W // 16) * (H // 16)):
        b.ue(25)      # mb_type I_PCM
        b.align_zero()  # pcm_alignment_zero_bits
        for _ in range(256):
            b.u(8, 16)   # luma: video black
        for _ in range(128):
            b.u(8, 128)  # chroma: neutral
    b.trailing()
    return nal(0x65, b.bytes())


# ---------------------------------------------------------------- MP4 boxes

def box(kind, *parts):
    data = b''.join(parts)
    return struct.pack('>I', 8 + len(data)) + kind + data


def full(kind, version, flags, *parts):
    return box(kind, struct.pack('>I', (version << 24) | flags), *parts)


MATRIX = struct.pack('>9I', 0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000)


def descriptor(tag, payload):
    assert len(payload) < 128
    return bytes([tag, len(payload)]) + payload


def build(offsets):
    sps_n, pps_n = sps(), pps()
    vsamples = [idr_slice(i % 2) for i in range(FRAMES)]
    vsamples = [struct.pack('>I', len(s)) + s for s in vsamples]
    v_dur = FRAMES * 1000
    a_dur_units = AAC_FRAMES * 1024
    movie_dur = max(v_dur, (a_dur_units * 1000 + SR - 1) // SR)

    avcc = box(b'avcC', bytes([1, 66, 0xC0, 30, 0xFF, 0xE1]), struct.pack('>H', len(sps_n)), sps_n, bytes([1]), struct.pack('>H', len(pps_n)), pps_n)
    avc1 = box(b'avc1', bytes(6), struct.pack('>H', 1), bytes(16), struct.pack('>HH', W, H), struct.pack('>II', 0x00480000, 0x00480000), bytes(4), struct.pack('>H', 1), bytes([9]) + b'keepawake' + bytes(22), struct.pack('>Hh', 0x18, -1), avcc)
    v_stbl = box(b'stbl',
                 full(b'stsd', 0, 0, struct.pack('>I', 1), avc1),
                 full(b'stts', 0, 0, struct.pack('>III', 1, FRAMES, 1000)),
                 full(b'stsc', 0, 0, struct.pack('>IIII', 1, 1, FRAMES, 1)),
                 full(b'stsz', 0, 0, struct.pack('>II', 0, FRAMES), b''.join(struct.pack('>I', len(s)) for s in vsamples)),
                 full(b'stco', 0, 0, struct.pack('>II', 1, offsets[0])))
    dinf = box(b'dinf', full(b'dref', 0, 0, struct.pack('>I', 1), full(b'url ', 0, 1)))
    v_trak = box(b'trak',
                 full(b'tkhd', 0, 3, struct.pack('>IIII', 0, 0, 1, 0), struct.pack('>I', movie_dur), bytes(8), struct.pack('>hhhH', 0, 0, 0, 0), MATRIX, struct.pack('>II', W << 16, H << 16)),
                 box(b'mdia',
                     full(b'mdhd', 0, 0, struct.pack('>IIII', 0, 0, VIDEO_TS, v_dur), struct.pack('>HH', 0x55C4, 0)),
                     full(b'hdlr', 0, 0, bytes(4), b'vide', bytes(12), b'VideoHandler\x00'),
                     box(b'minf', full(b'vmhd', 0, 1, bytes(8)), dinf, v_stbl)))
    esds_payload = descriptor(0x03, struct.pack('>HB', 2, 0) +
                              descriptor(0x04, bytes([0x40, 0x15]) + bytes([0, 0x01, 0x00]) + struct.pack('>II', 32000, 32000) + descriptor(0x05, ASC)) +
                              descriptor(0x06, bytes([0x02])))
    mp4a = box(b'mp4a', bytes(6), struct.pack('>H', 1), bytes(8), struct.pack('>HHHH', 1, 16, 0, 0), struct.pack('>I', SR << 16), full(b'esds', 0, 0, esds_payload))
    a_stbl = box(b'stbl',
                 full(b'stsd', 0, 0, struct.pack('>I', 1), mp4a),
                 full(b'stts', 0, 0, struct.pack('>III', 1, AAC_FRAMES, 1024)),
                 full(b'stsc', 0, 0, struct.pack('>IIII', 1, 1, AAC_FRAMES, 1)),
                 full(b'stsz', 0, 0, struct.pack('>II', len(SILENT_AAC), AAC_FRAMES)),
                 full(b'stco', 0, 0, struct.pack('>II', 1, offsets[1])))
    a_trak = box(b'trak',
                 full(b'tkhd', 0, 3, struct.pack('>IIII', 0, 0, 2, 0), struct.pack('>I', movie_dur), bytes(8), struct.pack('>hhhH', 0, 1, 0x0100, 0), MATRIX, struct.pack('>II', 0, 0)),
                 box(b'mdia',
                     full(b'mdhd', 0, 0, struct.pack('>IIII', 0, 0, SR, a_dur_units), struct.pack('>HH', 0x55C4, 0)),
                     full(b'hdlr', 0, 0, bytes(4), b'soun', bytes(12), b'SoundHandler\x00'),
                     box(b'minf', full(b'smhd', 0, 0, bytes(4)), dinf, a_stbl)))
    mvhd = full(b'mvhd', 0, 0, struct.pack('>IIII', 0, 0, 1000, movie_dur), struct.pack('>IH', 0x00010000, 0x0100), bytes(10), MATRIX, bytes(24), struct.pack('>I', 3))
    ftyp = box(b'ftyp', b'isom', struct.pack('>I', 0x200), b'isomiso2avc1mp41')
    moov = box(b'moov', mvhd, v_trak, a_trak)
    vdata = b''.join(vsamples)
    adata = SILENT_AAC * AAC_FRAMES
    mdat = box(b'mdat', vdata, adata)
    head = len(ftyp) + len(moov) + 8
    return ftyp + moov + mdat, (head, head + len(vdata))


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    data, offs = build((0, 0))
    data, offs2 = build(offs)
    assert offs == offs2
    with open(OUT, 'wb') as f:
        f.write(data)
    print(f'wrote {OUT}: {len(data)} bytes, {FRAMES} s video {W}x{H}, {AAC_FRAMES} silent AAC frames')


if __name__ == '__main__':
    main()
