cmake_minimum_required(VERSION 3.25)

project(chrome_control_mcp VERSION 1.5.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_AUTOMOC OFF)

option(ENABLE_ASAN_UBSAN "Enable AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
option(ENABLE_TSAN "Enable ThreadSanitizer" OFF)
if(ENABLE_ASAN_UBSAN AND ENABLE_TSAN)
    message(FATAL_ERROR "ENABLE_ASAN_UBSAN and ENABLE_TSAN cannot be combined")
endif()

function(enable_project_quality target)
    if(MSVC)
        target_compile_options(${target} PRIVATE /W4 /WX /permissive- /utf-8)
    elseif(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
        target_compile_options(${target} PRIVATE
            -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion -Werror
        )
    endif()

    if(ENABLE_ASAN_UBSAN)
        if(MSVC)
            message(FATAL_ERROR "ENABLE_ASAN_UBSAN requires Clang or GCC")
        endif()
        target_compile_options(${target} PRIVATE
            -fsanitize=address,undefined -fno-omit-frame-pointer
            -fno-sanitize-recover=all
        )
        target_link_options(${target} PRIVATE
            -fsanitize=address,undefined -fno-sanitize-recover=all
        )
    elseif(ENABLE_TSAN)
        if(MSVC)
            message(FATAL_ERROR "ENABLE_TSAN requires Clang or GCC")
        endif()
        target_compile_options(${target} PRIVATE
            -fsanitize=thread -fno-omit-frame-pointer
            -fno-sanitize-recover=all
        )
        target_link_options(${target} PRIVATE
            -fsanitize=thread -fno-sanitize-recover=all
        )
    endif()
endfunction()

find_package(Qt6 6.5 REQUIRED COMPONENTS Core Network)
find_package(Threads REQUIRED)

set(CCMCP_INCLUDE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/include")
set(CCMCP_CORE_SOURCES
    src/browser_bridge.cpp
    src/browser_bridge_security.cpp
    src/browser_contract.cpp
    src/browser_control.cpp
    src/browser_extension_installer.cpp
    src/browser_uploads.cpp
    src/install_layout.cpp
    src/native_messaging.cpp
    src/updater.cpp
)

# "Which process is on the other end, and is it running our binary" is asked by
# both the pipe server and the relay, and answered with different calls on each
# platform. Each platform gets ONE implementation of that answer: the copies
# that used to live in the pipe and relay units drifted apart on Windows, where
# the in-process and out-of-process image-path calls disagree under the
# `current` junction, and nothing in the build could notice.
if(WIN32)
    set(CCMCP_BRIDGE_PIPE_SOURCE src/browser_bridge_pipe.cpp)
    set(CCMCP_BRIDGE_RELAY_SOURCE src/browser_bridge_relay.cpp)
    set(CCMCP_PROCESS_IDENTITY_SOURCE src/windows_process_identity.cpp)
else()
    set(CCMCP_BRIDGE_PIPE_SOURCE src/browser_bridge_pipe_posix.cpp)
    set(CCMCP_BRIDGE_RELAY_SOURCE src/browser_bridge_relay_posix.cpp)
    set(CCMCP_PROCESS_IDENTITY_SOURCE src/posix_process_identity.cpp)
endif()
# The relay's stdio, frame decode, handshake and pump are identical on every
# platform; only connecting and watching the endpoint are not. The common half
# builds everywhere and the platform half beside it.
set(CCMCP_BRIDGE_RELAY_SOURCES
    ${CCMCP_BRIDGE_RELAY_SOURCE}
    src/browser_bridge_relay_common.cpp
)
# Likewise for the pipe server: the rendezvous record it publishes and defends,
# and the state it reports, are the same whatever the endpoint is.
set(CCMCP_BRIDGE_PIPE_SOURCES
    ${CCMCP_BRIDGE_PIPE_SOURCE}
    src/browser_bridge_pipe_common.cpp
)
list(APPEND CCMCP_CORE_SOURCES
    ${CCMCP_BRIDGE_PIPE_SOURCES}
    ${CCMCP_BRIDGE_RELAY_SOURCES}
    ${CCMCP_PROCESS_IDENTITY_SOURCE}
)

add_library(chrome_control_mcp_core STATIC ${CCMCP_CORE_SOURCES})
target_include_directories(chrome_control_mcp_core PUBLIC ${CCMCP_INCLUDE_DIR})
target_link_libraries(chrome_control_mcp_core PUBLIC Qt6::Core Qt6::Network Threads::Threads)
# The updater compares itself against published releases, so the version it
# reports has to be the one this build was cut from rather than a second copy
# of the number that someone can forget to raise.
target_compile_definitions(chrome_control_mcp_core PUBLIC
    CHROME_CONTROL_MCP_VERSION="${PROJECT_VERSION}"
)
enable_project_quality(chrome_control_mcp_core)
if(WIN32)
    target_link_libraries(chrome_control_mcp_core PUBLIC advapi32 shell32 user32)
    target_compile_definitions(chrome_control_mcp_core PUBLIC UNICODE _UNICODE)
elseif(APPLE)
    target_link_libraries(chrome_control_mcp_core PRIVATE proc)
else()
    target_compile_definitions(chrome_control_mcp_core PRIVATE _GNU_SOURCE)
endif()

add_executable(chrome_control_mcp
    src/main.cpp
    src/browser_mcp_tools.cpp
    src/mcp_dispatch.cpp
    src/mcp_entry.cpp
)
target_include_directories(chrome_control_mcp PRIVATE ${CCMCP_INCLUDE_DIR})
target_link_libraries(chrome_control_mcp PRIVATE chrome_control_mcp_core Qt6::Core)
enable_project_quality(chrome_control_mcp)
if(WIN32)
    target_compile_definitions(chrome_control_mcp PRIVATE UNICODE _UNICODE)
elseif(APPLE)
    set_target_properties(chrome_control_mcp PROPERTIES
        INSTALL_RPATH "@loader_path/Frameworks"
    )
else()
    set_target_properties(chrome_control_mcp PROPERTIES
        INSTALL_RPATH "$ORIGIN"
    )
endif()

# The unpacked extension is staged beside the executable on EVERY build, not as a post-build
# step of the executable: that step runs only when the executable relinks, so a change to the
# extension alone built "successfully" and left Chrome loading the previous copy.
add_custom_target(stage_browser_extension ALL
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${CMAKE_CURRENT_SOURCE_DIR}/browser/extension"
            "$<TARGET_FILE_DIR:chrome_control_mcp>/extension"
    COMMENT "Staging unpacked browser extension"
)
add_dependencies(stage_browser_extension chrome_control_mcp)
# The updater fetches releases over HTTPS, so the Qt TLS backend plugin has to
# travel with the executable. Which backend exists depends on how Qt was built
# (Schannel on Windows, SecureTransport on macOS, OpenSSL elsewhere), so ask the
# Qt package which ones it provides rather than hard-coding one and shipping an
# executable that cannot open a connection.
# Preference order per platform, most native first. Only ONE backend is shipped:
# the others carry runtime dependencies this package does not include -- the
# OpenSSL backend needs libssl, which is not staged on Windows or macOS -- and a
# plugin that cannot load is a confusing failure rather than a fallback.
if(WIN32)
    set(CCMCP_TLS_CANDIDATES
        Qt6::QSchannelBackendPlugin Qt6::QOpenSSLBackendPlugin)
elseif(APPLE)
    set(CCMCP_TLS_CANDIDATES
        Qt6::QSecureTransportBackendPlugin Qt6::QOpenSSLBackendPlugin)
else()
    set(CCMCP_TLS_CANDIDATES
        Qt6::QOpenSSLBackendPlugin Qt6::QTlsBackendOpenSSLPlugin)
endif()
set(CCMCP_TLS_PLUGIN_TARGETS "")
foreach(candidate ${CCMCP_TLS_CANDIDATES})
    if(TARGET ${candidate})
        set(CCMCP_TLS_PLUGIN_TARGETS ${candidate})
        break()
    endif()
endforeach()
if(NOT CCMCP_TLS_PLUGIN_TARGETS)
    message(WARNING
        "No Qt TLS backend plugin target was found; browser_update_check and "
        "browser_update_apply will not be able to reach the release host.")
endif()

if(WIN32)
    add_custom_command(TARGET chrome_control_mcp POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "$<TARGET_FILE:Qt6::Core>"
                "$<TARGET_FILE:Qt6::Network>"
                "$<TARGET_FILE_DIR:chrome_control_mcp>"
        COMMENT "Staging Qt runtime"
    )
endif()
foreach(plugin ${CCMCP_TLS_PLUGIN_TARGETS})
    add_custom_command(TARGET chrome_control_mcp POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E make_directory
                "$<TARGET_FILE_DIR:chrome_control_mcp>/tls"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "$<TARGET_FILE:${plugin}>"
                "$<TARGET_FILE_DIR:chrome_control_mcp>/tls"
        COMMENT "Staging Qt TLS backend"
    )
endforeach()

install(TARGETS chrome_control_mcp RUNTIME DESTINATION .)
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/LICENSE" DESTINATION .)
if(WIN32)
    install(FILES "$<TARGET_FILE:Qt6::Core>" "$<TARGET_FILE:Qt6::Network>"
            DESTINATION .)
endif()
foreach(plugin ${CCMCP_TLS_PLUGIN_TARGETS})
    install(FILES "$<TARGET_FILE:${plugin}>" DESTINATION tls)
endforeach()
install(DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/browser/extension/" DESTINATION extension)

include(CTest)
if(BUILD_TESTING)
    find_package(Qt6 6.5 REQUIRED COMPONENTS Test)

    function(configure_qt_test target)
        set_target_properties(${target} PROPERTIES AUTOMOC ON)
        target_include_directories(${target} PRIVATE ${CCMCP_INCLUDE_DIR})
        if(WIN32)
            target_compile_definitions(${target} PRIVATE UNICODE _UNICODE)
        elseif(NOT APPLE)
            target_compile_definitions(${target} PRIVATE _GNU_SOURCE)
        endif()
        enable_project_quality(${target})
        if(WIN32)
            add_custom_command(TARGET ${target} POST_BUILD
                COMMAND ${CMAKE_COMMAND} -E copy_if_different
                        "$<TARGET_FILE:Qt6::Core>" "$<TARGET_FILE_DIR:${target}>"
                COMMAND ${CMAKE_COMMAND} -E copy_if_different
                        "$<TARGET_FILE:Qt6::Test>" "$<TARGET_FILE_DIR:${target}>"
            )
        endif()
        add_test(NAME ${target} COMMAND ${target} -o "${target}.txt,txt")
    endfunction()

    add_executable(test_browser_contract
        tests/test_browser_contract.cpp
        src/browser_contract.cpp
    )
    target_link_libraries(test_browser_contract PRIVATE Qt6::Core Qt6::Test)
    configure_qt_test(test_browser_contract)
    # Windows only: the question it answers -- does a junction make one file
    # look like two processes -- does not exist where the install layout uses
    # a symbolic link and both sides already resolve it.
    if(WIN32)
        add_executable(test_windows_process_identity
            tests/test_windows_process_identity.cpp
            ${CCMCP_PROCESS_IDENTITY_SOURCE}
        )
        target_link_libraries(test_windows_process_identity PRIVATE Qt6::Core Qt6::Test)
        configure_qt_test(test_windows_process_identity)
    endif()

    add_executable(test_native_messaging
        tests/test_native_messaging.cpp
        src/native_messaging.cpp
    )
    target_link_libraries(test_native_messaging PRIVATE Qt6::Core Qt6::Test)
    configure_qt_test(test_native_messaging)

    add_executable(test_browser_bridge
        tests/test_browser_bridge.cpp
        src/browser_bridge.cpp
        src/browser_contract.cpp
    )
    target_link_libraries(test_browser_bridge PRIVATE Qt6::Core Qt6::Test)
    configure_qt_test(test_browser_bridge)

    add_executable(test_install_layout
        tests/test_install_layout.cpp
        src/install_layout.cpp
    )
    target_link_libraries(test_install_layout PRIVATE Qt6::Core Qt6::Test)
    configure_qt_test(test_install_layout)

    add_executable(test_updater
        tests/test_updater.cpp
        src/updater.cpp
        src/install_layout.cpp
        src/browser_extension_installer.cpp
    )
    target_link_libraries(test_updater PRIVATE Qt6::Core Qt6::Network Qt6::Test)
    if(WIN32)
        target_link_libraries(test_updater PRIVATE advapi32)
    endif()
    target_compile_definitions(test_updater PRIVATE
        CHROME_CONTROL_MCP_VERSION="${PROJECT_VERSION}"
    )
    configure_qt_test(test_updater)
    if(WIN32)
        add_custom_command(TARGET test_updater POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                    "$<TARGET_FILE:Qt6::Network>" "$<TARGET_FILE_DIR:test_updater>"
        )
    endif()

    add_executable(test_browser_extension_installer
        tests/test_browser_extension_installer.cpp
        src/browser_extension_installer.cpp
        src/install_layout.cpp
    )
    target_link_libraries(test_browser_extension_installer PRIVATE Qt6::Core Qt6::Test)
    if(WIN32)
        target_link_libraries(test_browser_extension_installer PRIVATE advapi32)
    endif()
    target_compile_definitions(test_browser_extension_installer PRIVATE
        CHROME_CONTROL_MCP_REPO_ROOT="${CMAKE_CURRENT_SOURCE_DIR}"
    )
    configure_qt_test(test_browser_extension_installer)

    add_executable(test_browser_uploads
        tests/test_browser_uploads.cpp
        src/browser_uploads.cpp
    )
    target_link_libraries(test_browser_uploads PRIVATE Qt6::Core Qt6::Test)
    configure_qt_test(test_browser_uploads)

    add_executable(test_browser_bridge_security
        tests/test_browser_bridge_security.cpp
        src/browser_bridge_security.cpp
    )
    target_link_libraries(test_browser_bridge_security PRIVATE Qt6::Core Qt6::Test)
    if(WIN32)
        target_link_libraries(test_browser_bridge_security PRIVATE advapi32)
    endif()
    configure_qt_test(test_browser_bridge_security)

    add_executable(test_browser_bridge_pipe
        tests/test_browser_bridge_pipe.cpp
        ${CCMCP_BRIDGE_PIPE_SOURCES}
        ${CCMCP_PROCESS_IDENTITY_SOURCE}
        src/browser_bridge_security.cpp
        src/native_messaging.cpp
    )
    target_link_libraries(test_browser_bridge_pipe PRIVATE Qt6::Core Qt6::Test Threads::Threads)
    if(WIN32)
        target_link_libraries(test_browser_bridge_pipe PRIVATE advapi32)
    elseif(APPLE)
        target_link_libraries(test_browser_bridge_pipe PRIVATE proc)
    endif()
    configure_qt_test(test_browser_bridge_pipe)

    add_executable(test_browser_bridge_relay
        tests/test_browser_bridge_relay.cpp
        ${CCMCP_BRIDGE_RELAY_SOURCES}
        ${CCMCP_PROCESS_IDENTITY_SOURCE}
        src/browser_control.cpp
        src/browser_bridge.cpp
        src/browser_contract.cpp
        src/browser_uploads.cpp
        # browser_control diagnoses a native-host registration that names another
        # copy of this program, which is the installer's knowledge to give, and
        # the installer registers the path that survives an update.
        src/browser_extension_installer.cpp
        src/install_layout.cpp
        ${CCMCP_BRIDGE_PIPE_SOURCES}
        src/browser_bridge_security.cpp
        src/native_messaging.cpp
    )
    target_link_libraries(test_browser_bridge_relay PRIVATE Qt6::Core Qt6::Test Threads::Threads)
    if(WIN32)
        target_link_libraries(test_browser_bridge_relay PRIVATE advapi32)
    elseif(APPLE)
        target_link_libraries(test_browser_bridge_relay PRIVATE proc)
    endif()
    configure_qt_test(test_browser_bridge_relay)

    add_executable(test_browser_mcp_server
        tests/test_browser_mcp_server.cpp
        src/browser_mcp_tools.cpp
        src/mcp_dispatch.cpp
    )
    target_link_libraries(test_browser_mcp_server PRIVATE
        chrome_control_mcp_core Qt6::Core Qt6::Test
    )
    configure_qt_test(test_browser_mcp_server)

    find_program(NODE_EXECUTABLE NAMES node REQUIRED)
    add_test(NAME test_browser_extension_pure
        COMMAND "${NODE_EXECUTABLE}" --test
                "${CMAKE_CURRENT_SOURCE_DIR}/tests/test_browser_extension_pure.mjs"
    )
    set_tests_properties(test_browser_extension_pure PROPERTIES TIMEOUT 120)

    add_test(NAME test_browser_extension_recording
        COMMAND "${NODE_EXECUTABLE}" --test
                "${CMAKE_CURRENT_SOURCE_DIR}/tests/test_browser_extension_recording.mjs"
    )
    set_tests_properties(test_browser_extension_recording PROPERTIES TIMEOUT 120)

    add_test(NAME test_browser_extension_multisession
        COMMAND "${NODE_EXECUTABLE}" --test
                "${CMAKE_CURRENT_SOURCE_DIR}/tests/test_browser_extension_multisession.mjs"
    )
    set_tests_properties(test_browser_extension_multisession PROPERTIES TIMEOUT 120)

    add_test(NAME test_browser_extension_session
        COMMAND "${NODE_EXECUTABLE}" --test
                "${CMAKE_CURRENT_SOURCE_DIR}/tests/test_browser_extension_session.mjs"
    )
    set_tests_properties(test_browser_extension_session PROPERTIES TIMEOUT 120)

    add_test(NAME test_browser_extension_transport
        COMMAND "${NODE_EXECUTABLE}" --test
                "${CMAKE_CURRENT_SOURCE_DIR}/tests/test_browser_extension_transport.mjs"
    )
    set_tests_properties(test_browser_extension_transport PROPERTIES TIMEOUT 120)

    add_test(NAME test_vscode_payload
        COMMAND "${NODE_EXECUTABLE}" --test
                "${CMAKE_CURRENT_SOURCE_DIR}/tests/test_vscode_payload.mjs"
    )
    set_tests_properties(test_vscode_payload PROPERTIES TIMEOUT 120)
endif()
