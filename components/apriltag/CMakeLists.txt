idf_component_register(
    SRCS
        "apriltag.c"
        "apriltag_pose.c"
        "apriltag_quad_thresh.c"
        "tag36h11.c"
        "common/g2d.c"
        "common/homography.c"
        "common/image_u8.c"
        "common/image_u8_parallel.c"
        "common/image_u8x3.c"
        "common/image_u8x4.c"
        "common/matd.c"
        "common/pthreads_cross.c"
        "common/string_util.c"
        "common/svd22.c"
        "common/time_util.c"
        "common/unionfind.c"
        "common/workerpool.c"
        "common/zarray.c"
        "common/zhash.c"
        "common/zmaxheap.c"
    INCLUDE_DIRS "."
    REQUIRES pthread
)

# ESP32-P4 compiler defines int32_t as long int on RISC-V,
# and treats char as unsigned, but upstream apriltag uses %d
# for int32_t fields and passes char to isspace()/islower().
# Suppress these errors (keep warnings visible) rather than
# patching 30+ foreign sources.
target_compile_options(${COMPONENT_LIB} PRIVATE
    -Wno-error=format
    -Wno-error=char-subscripts
)
# workerpool.c re-defines _GNU_SOURCE that IDF already sets.
target_compile_options(${COMPONENT_LIB} PRIVATE
    -Wno-builtin-macro-redefined
)
